import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { AUTH_HEADER, internalAuthHeaders, requireInternalKey, safeEqual } from "./auth.js";

const orig = process.env.INTERNAL_API_KEY;
afterEach(() => {
  if (orig === undefined) delete process.env.INTERNAL_API_KEY;
  else process.env.INTERNAL_API_KEY = orig;
});

function app() {
  const a = new Hono();
  a.use("*", requireInternalKey());
  a.get("/", (c) => c.text("ok"));
  return a;
}

test("safeEqual", () => {
  assert.ok(safeEqual("abc", "abc"));
  assert.ok(!safeEqual("abc", "abd"));
  assert.ok(!safeEqual("abc", "abcd"));
  assert.ok(!safeEqual("", "abc"));
});

test("sin key configurada no exige auth", async () => {
  delete process.env.INTERNAL_API_KEY;
  assert.equal((await app().request("/")).status, 200);
  assert.deepEqual(internalAuthHeaders(), {});
});

test("con key: 401 sin header o incorrecto, 200 correcto", async () => {
  process.env.INTERNAL_API_KEY = "s3cret";
  assert.equal((await app().request("/")).status, 401);
  assert.equal((await app().request("/", { headers: { [AUTH_HEADER]: "nope" } })).status, 401);
  assert.equal((await app().request("/", { headers: { [AUTH_HEADER]: "s3cret" } })).status, 200);
  assert.deepEqual(internalAuthHeaders(), { [AUTH_HEADER]: "s3cret" });
});
