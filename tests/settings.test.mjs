import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSecrets, settings } from "../web/settings.mjs";

test("public hosting rejects unsafe origins, trust-all proxies and port collisions", () => {
  for (const url of ["http://public.example", "https://user:pass@example.com", "https://example.com/opencode/",
    "https://example.com/?secret=value", "https://example.com/#fragment", "file:///tmp/test"]) {
    assert.throws(() => settings({ OPENCODE_PUBLIC_URL: url }));
  }
  assert.throws(() => settings({ OPENCODE_PUBLIC_URL: "https://code.example" }));
  for (const proxies of ["0.0.0.0/0", "::/0", "127.0.0.1/99", "127.0.0.1\nfrontend injected", "localhost"]) {
    assert.throws(() => settings({ OPENCODE_TRUSTED_PROXIES: proxies }));
  }
  assert.throws(() => settings({ OPENCODE_WEB_PORT: "4097" }));
  assert.throws(() => settings({ OPENCODE_WEB_PORT: "4096\nbind :1234" }));
  assert.equal(settings({}).origin, "http://localhost:4096");
  assert.equal(settings({ OPENCODE_PUBLIC_URL: "https://CODE.example/", OPENCODE_TRUSTED_PROXIES: "192.0.2.1,2001:db8::1/128" }).origin,
    "https://code.example");
});

test("file secrets are read without exposing values or silently overriding other credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-secrets-"));
  try {
    const file = join(dir, "password");
    const password = "a".repeat(64);
    writeFileSync(file, password + "\n", { mode: 0o600 });
    const result = loadSecrets({ OPENCODE_SERVER_PASSWORD_FILE: file });
    assert.equal(result.OPENCODE_PASSWORD, password);
    assert.equal(result.OPENCODE_SERVER_PASSWORD, password);
    assert.equal(result.OPENCODE_SERVER_PASSWORD_FILE, undefined);
    assert.throws(() => loadSecrets({ OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_PASSWORD_FILE: file }), /not both/);
    for (const value of ["", "short", `${password}\nmalicious`, "x".repeat(20000)]) {
      writeFileSync(file, value);
      assert.throws(() => loadSecrets({ OPENCODE_SERVER_PASSWORD_FILE: file }), error => !error.message.includes(password));
    }
    assert.throws(() => loadSecrets({ OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: "admin" }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
