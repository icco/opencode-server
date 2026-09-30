// Package guard provides request checks and a bounded native-auth failure ledger.
// It never parses credentials or implements authentication. OpenCode authenticates;
// Caddy's standard reverse_proxy handles HTTP, streaming and WebSockets.
package guard

import (
	"container/list"
	"fmt"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/caddyserver/caddy/v2"
	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
)

const (
	window     = 10 * time.Minute
	maxFails   = 20
	maxClients = 100000
)

func init() { caddy.RegisterModule(Guard{}) }

type Guard struct {
	Origin         string   `json:"origin"`
	TrustedProxies []string `json:"trusted_proxies,omitempty"`

	host   string
	secure bool
	peers  []netip.Prefix
	fails  *ledger
}

func (Guard) CaddyModule() caddy.ModuleInfo {
	return caddy.ModuleInfo{ID: "http.handlers.opencode_guard", New: func() caddy.Module { return new(Guard) }}
}

func (g *Guard) Provision(caddy.Context) error {
	u, err := url.Parse(g.Origin)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" ||
		(u.Path != "" && u.Path != "/") || (u.Scheme != "http" && u.Scheme != "https") {
		return fmt.Errorf("opencode_guard requires a public origin")
	}
	g.host, g.secure = u.Host, u.Scheme == "https"
	for _, value := range g.TrustedProxies {
		prefix, err := netip.ParsePrefix(value)
		if err != nil {
			if ip, ipErr := netip.ParseAddr(value); ipErr == nil {
				prefix, err = netip.PrefixFrom(ip, ip.BitLen()), nil
			}
		}
		if err != nil || prefix.Bits() == 0 {
			return fmt.Errorf("opencode_guard requires explicit trusted proxy IPs/CIDRs")
		}
		g.peers = append(g.peers, prefix)
	}
	if g.secure && len(g.peers) == 0 {
		return fmt.Errorf("HTTPS hosting requires a trusted TLS proxy")
	}
	g.fails = newLedger(maxClients)
	return nil
}

func (g *Guard) ServeHTTP(w http.ResponseWriter, r *http.Request, next caddyhttp.Handler) error {
	peer, err := netip.ParseAddrPort(r.RemoteAddr)
	if err != nil {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return nil
	}
	ip := peer.Addr().Unmap()
	trusted := false
	for _, prefix := range g.peers {
		trusted = trusted || prefix.Contains(ip)
	}
	if g.secure {
		proto := r.Header.Values("X-Forwarded-Proto")
		if (!trusted && !ip.IsLoopback()) || (trusted && (len(proto) != 1 || proto[0] != "https")) {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return nil
		}
	}
	if !strings.EqualFold(r.Host, g.host) {
		http.Error(w, "Misdirected Request", http.StatusMisdirectedRequest)
		return nil
	}
	origins := r.Header.Values("Origin")
	if len(origins) > 1 || (len(origins) == 1 && origins[0] != g.Origin) {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return nil
	}
	if trusted {
		// Only the rightmost address appended by the trusted edge is authoritative.
		values := strings.Split(strings.Join(r.Header.Values("X-Forwarded-For"), ","), ",")
		if forwarded, err := netip.ParseAddr(strings.TrimSpace(values[len(values)-1])); err == nil {
			ip = forwarded.Unmap()
		}
	}
	caddyhttp.SetVar(r.Context(), "opencode_client_ip", ip.String())
	caddyhttp.SetVar(r.Context(), caddyhttp.ClientIPVarKey, ip.String())
	for _, name := range []string{"Forwarded", "X-Real-IP", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto"} {
		r.Header.Del(name)
	}
	if g.fails.blocked(ip, time.Now()) {
		w.Header().Set("Retry-After", "600")
		http.Error(w, "Too many authentication failures", http.StatusTooManyRequests)
		return nil
	}
	// Caddy's recorder preserves streaming/Hijacker interfaces and does not buffer.
	recorder := caddyhttp.NewResponseRecorder(w, nil, func(status int, _ http.Header) bool {
		if status == http.StatusUnauthorized {
			g.fails.record(ip, time.Now())
		}
		return false
	})
	return next.ServeHTTP(recorder, r)
}

type failures struct {
	ip    netip.Addr
	times []time.Time
}

type ledger struct {
	mu    sync.Mutex
	limit int
	byIP  map[netip.Addr]*list.Element
	lru   *list.List
}

func newLedger(limit int) *ledger {
	return &ledger{limit: limit, byIP: make(map[netip.Addr]*list.Element), lru: list.New()}
}

func trim(times []time.Time, now time.Time) []time.Time {
	kept := times[:0]
	for _, timestamp := range times {
		if timestamp.After(now.Add(-window)) {
			kept = append(kept, timestamp)
		}
	}
	return kept
}

func (l *ledger) blocked(ip netip.Addr, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry := l.byIP[ip]
	if entry == nil {
		return false
	}
	f := entry.Value.(*failures)
	f.times = trim(f.times, now)
	if len(f.times) == 0 {
		delete(l.byIP, ip)
		l.lru.Remove(entry)
		return false
	}
	l.lru.MoveToFront(entry)
	return len(f.times) >= maxFails
}

func (l *ledger) record(ip netip.Addr, now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry := l.byIP[ip]
	if entry == nil {
		if len(l.byIP) >= l.limit {
			oldest := l.lru.Back()
			delete(l.byIP, oldest.Value.(*failures).ip)
			l.lru.Remove(oldest)
		}
		entry = l.lru.PushFront(&failures{ip: ip})
		l.byIP[ip] = entry
	}
	f := entry.Value.(*failures)
	f.times = trim(f.times, now)
	// Concurrent requests already in flight may fail after the threshold is hit.
	// Keep only the most recent failures instead of growing the ledger per IP.
	if len(f.times) >= maxFails {
		f.times = f.times[len(f.times)-maxFails+1:]
	}
	f.times = append(f.times, now)
	l.lru.MoveToFront(entry)
}

var (
	_ caddy.Provisioner           = (*Guard)(nil)
	_ caddyhttp.MiddlewareHandler = (*Guard)(nil)
)
