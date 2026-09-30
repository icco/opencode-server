import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { gateway, auth } from "./helpers.mjs";

test("gateway preserves authentication, upstream CSP and caching of static assets", async t => {
  const p = await gateway(t);
  for (const path of ["/api/info", "/api/session", "/api/event", "/openapi.json"]) {
    const r = await p.send(path, { Authorization: "Basic incorrect" });
    assert.equal(r.status, 401);
    assert.equal(r.headers["www-authenticate"], "Basic");
    assert.equal(r.headers["cache-control"], "no-store");
  }
  const r = await p.send();
  assert.equal(r.status, 200);
  assert.equal(r.headers["x-frame-options"], "DENY");
  assert.equal(r.headers["referrer-policy"], "no-referrer");
  assert.equal(r.headers["cache-control"], "no-store");
  assert.match(r.headers["content-security-policy"], /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(r.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal((await p.send("/_assets/app.js")).headers["cache-control"], "public, max-age=3600");
});

test("foreign/null/duplicate origins and forged hosts are rejected", async t => {
  const p = await gateway(t);
  for (const origin of ["null", "https://attacker.example", "http://other.localhost:4096", [p.s.origin, "https://attacker.example"]]) {
    for (const method of ["GET", "POST", "OPTIONS"]) {
      assert.equal((await p.send("/api/info", { Origin: origin }, method)).status, 403);
    }
  }
  assert.equal((await p.send("/api/info", { Origin: p.s.origin }, "POST")).status, 200);
  assert.equal((await p.send("/api/info", { Host: "attacker.example" })).status, 421);
});

test("only explicit proxy peers can supply client addresses and HTTPS provenance", async t => {
  const untrusted = await gateway(t);
  const result = JSON.parse((await untrusted.send("/api/info", {
    "X-Forwarded-For": "203.0.113.99", "X-Forwarded-Proto": "https",
    "X-Forwarded-Host": "attacker.example", Forwarded: "host=attacker.example", "X-Real-IP": "203.0.113.99",
  })).body);
  assert.equal(result["x-forwarded-for"], "127.0.0.1");
  assert.equal(result["x-forwarded-proto"], "http");
  assert.equal(result["x-forwarded-host"], untrusted.s.host);
  assert.equal(result.forwarded, undefined);
  assert.equal(result["x-real-ip"], undefined);
  const trusted = await gateway(t, { secure: true, proxies: ["127.0.0.1/32"] });
  const good = await trusted.send("/api/info", { "X-Forwarded-For": "192.0.2.88, 203.0.113.42" });
  assert.equal(JSON.parse(good.body)["x-forwarded-for"], "203.0.113.42");
  assert.equal(good.headers["strict-transport-security"], "max-age=31536000");
  assert.equal((await trusted.send("/api/info", { "X-Forwarded-Proto": "http" })).status, 403);
});

test("twenty backend authentication failures throttle that client without counting successful traffic or origin denials", async t => {
  const p = await gateway(t, { secure: true, proxies: ["127.0.0.1/32"] });
  const ip = { "X-Forwarded-For": "203.0.113.55" };
  for (let n = 0; n < 25; n++) {
    assert.equal((await p.send("/api/info", ip)).status, 200);
    assert.equal((await p.send("/api/info", { ...ip, Origin: "https://attacker.example" })).status, 403);
  }
  for (let n = 0; n < 20; n++) assert.equal((await p.send("/api/info", { ...ip, Authorization: "Basic incorrect" })).status, 401);
  const blocked = await p.send("/api/info", ip);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers["retry-after"], "600");
  assert.equal((await p.send("/api/info", { "X-Forwarded-For": "203.0.113.56" })).status, 200);
  assert.equal((await p.send("/api/info", { "X-Forwarded-For": "192.0.2.99, 203.0.113.55" })).status, 429);
});

test("streaming and WebSocket upgrades work without buffering or bypassing origin checks", async t => {
  const p = await gateway(t, {
    handler: (req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: first\n\n");
      setTimeout(() => res.end("data: second\n\n"), 100);
    },
    upgrade: (req, socket) => {
      const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.end(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    },
  });
  const req = request({ ...p.options(), path: "/api/event" });
  req.end();
  const [res] = await once(req, "response");
  const chunks = [];
  await new Promise((resolve, reject) => {
    res.on("data", chunk => { chunks.push(chunk.toString()); });
    res.on("end", resolve);
    res.on("error", reject);
  });
  assert.equal(chunks[0], "data: first\n\n");
  assert.equal(chunks.join(""), "data: first\n\ndata: second\n\n");
  const headers = { Origin: p.s.origin, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" };
  const ws = request({ ...p.options(headers), path: "/api/pty/test/connect?token=ticket-secret-marker" });
  ws.end();
  const [response, socket] = await once(ws, "upgrade");
  assert.equal(response.statusCode, 101);
  socket.destroy();
  assert.equal((await p.send("/api/pty/test/connect", { ...headers, Origin: "https://attacker.example" })).status, 403);
});

test("access and transport-error logs contain no credential-bearing URLs or headers", async t => {
  const p = await gateway(t, { handler: (req, res) => {
    if (req.url.startsWith("/auth/connect/")) { req.socket.destroy(); return; }
    res.writeHead(200, { Location: "/auth/connect/response-secret-marker", "Set-Cookie": "session=cookie-secret-marker" });
    res.end("ok");
  } });
  const headers = { Authorization: auth, Cookie: "session=cookie-secret-marker", Referer: "https://code.example/?auth_token=referer-secret-marker" };
  await p.send("/api/info?auth_token=query-secret-marker", headers);
  assert.equal((await p.send("/auth/connect/pairing-secret-marker", headers)).status, 502);
  await p.stop();
  for (const marker of [auth, "query-secret-marker", "referer-secret-marker", "pairing-secret-marker", "response-secret-marker", "cookie-secret-marker"]) {
    assert.ok(!p.logs().includes(marker), `logs leaked ${marker}`);
  }
  assert.match(p.logs(), /"component":"gateway"/);
});
