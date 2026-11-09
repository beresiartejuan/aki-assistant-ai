import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

let server: Server;
let hits: Array<{ auth?: string; body: any }> = [];
let responses: Array<{ status: number; body: unknown }> = [];

before(async () => {
  server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      hits.push({ auth: req.headers.authorization, body: JSON.parse(data || "{}") });
      const r = responses.shift() ?? { status: 500, body: { error: "sin respuesta" } };
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.OLLAMA_API_KEY = "";
  process.env.OLLAMA_RETRY_BASE_MS = "1";
  process.env.OLLAMA_MAX_RETRIES = "2";
  process.env.OLLAMA_TIMEOUT_MS = "2000";
});
after(() => server.close());

const ok = { status: 200, body: { model: "m", message: { role: "assistant", content: "hola" } } };
const load = () => import("./ollama.js");

test("helpers: isLocalUrl, buildHeaders, isRetryableStatus, backoff", async () => {
  const o = await load();
  assert.ok(o.isLocalUrl("http://localhost:11434"));
  assert.ok(o.isLocalUrl("http://127.0.0.1:11434"));
  assert.ok(!o.isLocalUrl("https://ollama.com"));
  assert.equal(o.buildHeaders("").authorization, undefined);
  assert.equal(o.buildHeaders("k").authorization, "Bearer k");
  assert.ok(o.isRetryableStatus(429) && o.isRetryableStatus(503));
  assert.ok(!o.isRetryableStatus(400) && !o.isRetryableStatus(404));
  assert.deepEqual([0, 1, 2].map((a) => o.backoffDelayMs(a, 100)), [100, 200, 400]);
});

test("sin API key en localhost: no envía authorization y mapea tool_calls", async () => {
  const { chat } = await load();
  hits = [];
  responses = [ok];
  const r = await chat([
    { role: "user", content: "x" },
    { role: "assistant", content: "", toolCalls: [{ function: { name: "t", arguments: {} } }] },
  ]);
  assert.equal(r.content, "hola");
  assert.equal(hits[0].auth, undefined);
  assert.ok(hits[0].body.messages[1].tool_calls);
  assert.equal(hits[0].body.messages[1].toolCalls, undefined);
});

test("reintenta 5xx y 429 hasta tener éxito", async () => {
  const { chat } = await load();
  hits = [];
  responses = [{ status: 503, body: { error: "x" } }, { status: 429, body: { error: "y" } }, ok];
  const r = await chat([{ role: "user", content: "x" }]);
  assert.equal(r.content, "hola");
  assert.equal(hits.length, 3);
});

test("no reintenta 4xx", async () => {
  const { chat } = await load();
  hits = [];
  responses = [{ status: 400, body: { error: "bad" } }, ok];
  await assert.rejects(chat([{ role: "user", content: "x" }]), /400/);
  assert.equal(hits.length, 1);
});

test("agota reintentos y lanza el último error", async () => {
  const { chat } = await load();
  hits = [];
  responses = [500, 500, 500, 500].map((status) => ({ status, body: { error: "boom" } }));
  await assert.rejects(chat([{ role: "user", content: "x" }]), /500/);
  assert.equal(hits.length, 3); // 1 + 2 reintentos
});
