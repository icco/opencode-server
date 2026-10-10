import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSecrets, settings } from "../web/settings.mjs";

test("native V2 password configuration remains usable by the server and CLI", () => {
  const password = "native-password-".repeat(4);
  assert.equal(loadSecrets({ OPENCODE_PASSWORD: password }).OPENCODE_PASSWORD, password);
  for (const value of ["", "short", `${password}\n`, "x".repeat(4097)]) {
    assert.throws(() => loadSecrets({ OPENCODE_PASSWORD: value }));
  }
});

test("native password and MCP tokens support mutually exclusive file secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-native-secrets-"));
  try {
    const file = join(dir, "secret");
    const password = "native-password-".repeat(4);
    writeFileSync(file, password + "\n", { mode: 0o600 });
    const result = loadSecrets({ OPENCODE_PASSWORD_FILE: file,
      LUNCHMONEY_API_TOKEN_FILE: file, GRAFANA_SERVICE_ACCOUNT_TOKEN_FILE: file, KARAKEEP_API_KEY_FILE: file });
    for (const name of ["OPENCODE_PASSWORD", "LUNCHMONEY_API_TOKEN", "GRAFANA_SERVICE_ACCOUNT_TOKEN", "KARAKEEP_API_KEY"]) {
      assert.equal(result[name], password);
      assert.equal(result[`${name}_FILE`], undefined);
      assert.throws(() => loadSecrets({ OPENCODE_PASSWORD: password, [name]: password, [`${name}_FILE`]: file }), /not both/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Karakeep accepts direct keys and rejects invalid file secrets without exposing them", () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-karakeep-secrets-"));
  const password = "native-password-".repeat(4);
  const key = "karakeep-test-only-key";
  try {
    assert.equal(loadSecrets({ OPENCODE_PASSWORD: password, KARAKEEP_API_KEY: key }).KARAKEEP_API_KEY, key);
    const file = join(dir, "key");
    const env = { OPENCODE_PASSWORD: password, KARAKEEP_API_KEY_FILE: file };
    assert.throws(() => loadSecrets(env), /Cannot read KARAKEEP_API_KEY_FILE/);
    assert.throws(() => loadSecrets({ ...env, KARAKEEP_API_KEY_FILE: dir }), /Cannot read KARAKEEP_API_KEY_FILE/);
    writeFileSync(file, key + "\r\n", { mode: 0o600 });
    assert.equal(loadSecrets(env).KARAKEEP_API_KEY, key);
    for (const value of ["", `${key}\nextra`, `${key}\0`, "x".repeat(16385)]) {
      writeFileSync(file, value);
      assert.throws(() => loadSecrets(env), error =>
        /KARAKEEP_API_KEY_FILE/.test(error.message) && !error.message.includes(key));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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
    const result = loadSecrets({ OPENCODE_PASSWORD_FILE: file });
    assert.equal(result.OPENCODE_PASSWORD, password);
    assert.equal(result.OPENCODE_PASSWORD_FILE, undefined);
    assert.throws(() => loadSecrets({ OPENCODE_PASSWORD: password, OPENCODE_PASSWORD_FILE: file }), /not both/);
    for (const value of ["", "short", `${password}\nmalicious`, "x".repeat(20000)]) {
      writeFileSync(file, value);
      assert.throws(() => loadSecrets({ OPENCODE_PASSWORD_FILE: file }), error => !error.message.includes(password));
    }
    assert.throws(() => loadSecrets({ OPENCODE_PASSWORD: password, OPENCODE_SERVER_USERNAME: "admin" }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
