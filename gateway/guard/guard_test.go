package guard

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"sync"
	"testing"
	"time"

	"github.com/caddyserver/caddy/v2"
	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
)

func TestWindowExpiryAndClientIsolation(t *testing.T) {
	l := newLedger(10)
	ip, other := netip.MustParseAddr("192.0.2.10"), netip.MustParseAddr("2001:db8::10")
	now := time.Now()
	for i := 0; i < maxFails; i++ {
		if l.blocked(ip, now) {
			t.Fatal("blocked before reaching the failure threshold")
		}
		l.record(ip, now)
	}
	if !l.blocked(ip, now) || l.blocked(other, now) {
		t.Fatal("failures were not isolated to their client")
	}
	if !l.blocked(ip, now.Add(window-time.Nanosecond)) || l.blocked(ip, now.Add(window)) {
		t.Fatal("incorrect expiration boundary")
	}
	if len(l.byIP) != 0 {
		t.Fatal("expired entries were not reclaimed")
	}
	// Concurrent responses can acquire the mutex out of timestamp order.
	got := trim([]time.Time{now.Add(time.Second), now}, now.Add(window))
	if len(got) != 1 || !got[0].Equal(now.Add(time.Second)) {
		t.Fatal("out-of-order expired failures were retained")
	}
}

func TestBoundedLRUEviction(t *testing.T) {
	l := newLedger(2)
	a, b, c := netip.MustParseAddr("192.0.2.1"), netip.MustParseAddr("192.0.2.2"), netip.MustParseAddr("192.0.2.3")
	now := time.Now()
	l.record(a, now)
	l.record(b, now)
	l.blocked(a, now) // Refresh a; b is now least recently used.
	l.record(c, now)
	if len(l.byIP) != 2 || l.lru.Len() != 2 || l.byIP[b] != nil || l.byIP[a] == nil || l.byIP[c] == nil {
		t.Fatal("client ledger did not honor its memory bound/LRU order")
	}
}

func TestConcurrentInflightFailuresStayBounded(t *testing.T) {
	l := newLedger(10)
	ip := netip.MustParseAddr("2001:db8::42")
	now := time.Now()
	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for n := 0; n < 100; n++ {
				l.record(ip, now)
				l.blocked(ip, now)
			}
		}()
	}
	wg.Wait()
	if len(l.byIP[ip].Value.(*failures).times) != maxFails || !l.blocked(ip, now) {
		t.Fatal("in-flight failures exceeded the per-client bound or failed to block")
	}
}

func TestRejectedRequestsNeverReachBackendOrAllocateCounters(t *testing.T) {
	g := &Guard{Origin: "https://code.example", TrustedProxies: []string{"192.0.2.1/32"}}
	if err := g.Provision(caddy.Context{}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, peer, host string
		origins, proto   []string
		status           int
	}{
		{"untrusted TLS provenance", "192.0.2.2:1234", "code.example", nil, []string{"https"}, 403},
		{"duplicate TLS provenance", "192.0.2.1:1234", "code.example", nil, []string{"https", "https"}, 403},
		{"wrong host", "192.0.2.1:1234", "attacker.example", nil, []string{"https"}, 421},
		{"duplicate origins", "192.0.2.1:1234", "code.example", []string{g.Origin, g.Origin}, []string{"https"}, 403},
		{"foreign origin", "192.0.2.1:1234", "code.example", []string{"https://attacker.example"}, []string{"https"}, 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "https://code.example/api/info", nil)
			r = r.WithContext(context.WithValue(r.Context(), caddyhttp.VarsCtxKey, map[string]any{}))
			r.RemoteAddr, r.Host = tc.peer, tc.host
			r.Header["Origin"], r.Header["X-Forwarded-Proto"] = tc.origins, tc.proto
			w := httptest.NewRecorder()
			if err := g.ServeHTTP(w, r, caddyhttp.HandlerFunc(func(http.ResponseWriter, *http.Request) error {
				t.Fatal("rejected request reached backend")
				return nil
			})); err != nil {
				t.Fatal(err)
			}
			if w.Code != tc.status || len(g.fails.byIP) != 0 {
				t.Fatalf("status=%d, clients=%d", w.Code, len(g.fails.byIP))
			}
		})
	}
}
