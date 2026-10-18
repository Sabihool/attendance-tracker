/** Part 20 — CORS allow-list, production configuration checks, database connection options. */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cors from "cors";
import { parseAllowedOrigins, buildCorsOptions, DEFAULT_DEV_ORIGIN } from "../utils/corsConfig.js";
import { checkSecurityConfig } from "../utils/securityConfig.js";
import { mongoConnectOptions } from "../database/connection.js";

const SECRET = "s".repeat(48);

test("CLIENT_URL: one or several origins, normalised; '*' and junk are reported; unset falls back to the dev origin", () => {
  assert.deepEqual(parseAllowedOrigins("https://a.example.com/").origins, ["https://a.example.com"]);
  assert.deepEqual(parseAllowedOrigins(" https://a.example.com , https://b.example.com:8443/app ").origins, ["https://a.example.com", "https://b.example.com:8443"]);
  assert.deepEqual(parseAllowedOrigins("*").invalid, ["*"]);
  assert.deepEqual(parseAllowedOrigins("*").origins, [], "a wildcard never becomes an allowed origin");
  assert.deepEqual(parseAllowedOrigins("ftp://x.example.com, not a url").invalid.length, 2);
  assert.deepEqual(parseAllowedOrigins(undefined).origins, [DEFAULT_DEV_ORIGIN]);
  assert.equal(parseAllowedOrigins(undefined).configured, false);
});

test("CORS over real HTTP: listed origins get headers (with credentials), others get none, no-Origin requests still work", async () => {
  const app = express();
  app.use(cors(buildCorsOptions("https://app.example.com, https://www.example.com")));
  app.get("/ping", (_q, r) => r.json({ ok: true }));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${base}/ping`, { headers: { Origin: "https://app.example.com" } });
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://app.example.com");
    assert.equal(ok.headers.get("access-control-allow-credentials"), "true");
    const second = await fetch(`${base}/ping`, { headers: { Origin: "https://www.example.com" } });
    assert.equal(second.headers.get("access-control-allow-origin"), "https://www.example.com");
    for (const evil of ["https://evil.example.com", "https://app.example.com.evil.com", "http://app.example.com", "null"]) {
      const r = await fetch(`${base}/ping`, { headers: { Origin: evil } });
      assert.equal(r.headers.get("access-control-allow-origin"), null, `${evil} gets no CORS headers`);
    }
    const pre = await fetch(`${base}/ping`, { method: "OPTIONS", headers: { Origin: "https://evil.example.com", "Access-Control-Request-Method": "GET" } });
    assert.equal(pre.headers.get("access-control-allow-origin"), null);
    const noOrigin = await fetch(`${base}/ping`);
    assert.equal(noOrigin.status, 200);
    assert.equal(noOrigin.headers.get("access-control-allow-origin"), null);
  } finally { await new Promise((r) => server.close(r)); }
});

test("production refuses to start with a missing/weak secret, a missing, localhost-only, plain-http or wildcard CLIENT_URL", () => {
  const prod = { JWT_SECRET: SECRET, NODE_ENV: "production" };
  assert.equal(checkSecurityConfig({ ...prod, CLIENT_URL: "https://app.example.com" }).ok, true);
  for (const [name, env] of Object.entries({
    "no CLIENT_URL": { ...prod },
    "localhost only": { ...prod, CLIENT_URL: "http://localhost:5173" },
    "plain http": { ...prod, CLIENT_URL: "http://app.example.com" },
    "wildcard": { ...prod, CLIENT_URL: "*" },
    "weak secret": { ...prod, JWT_SECRET: "short", CLIENT_URL: "https://app.example.com" },
    "short backup key": { ...prod, CLIENT_URL: "https://app.example.com", BACKUP_SIGNING_KEY: "tiny" },
  })) {
    const r = checkSecurityConfig(env);
    assert.equal(r.ok, false, name);
    assert.equal(r.production, true);
  }
  // development stays permissive (warn only) but still flags a wildcard
  assert.equal(checkSecurityConfig({ JWT_SECRET: SECRET }).ok, true);
  assert.equal(checkSecurityConfig({ JWT_SECRET: SECRET, CLIENT_URL: "*" }).ok, false);
});

test("scripts and server share one database selection (DB_NAME, default attendance_tracker) and fail fast", () => {
  assert.equal(mongoConnectOptions({}).dbName, "attendance_tracker");
  assert.equal(mongoConnectOptions({ DB_NAME: "prod_db" }).dbName, "prod_db");
  assert.equal(mongoConnectOptions({}).serverSelectionTimeoutMS, 15000);
  assert.equal(mongoConnectOptions({ MONGO_SERVER_SELECTION_TIMEOUT_MS: "3000" }).serverSelectionTimeoutMS, 3000);
});
