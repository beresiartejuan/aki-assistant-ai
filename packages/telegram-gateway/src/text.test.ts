import { test } from "node:test";
import assert from "node:assert/strict";
import { splitMessage } from "./text.js";
import { keysMatch } from "./auth.js";

test("texto corto queda intacto", () => {
  assert.deepEqual(splitMessage("hola"), ["hola"]);
  assert.deepEqual(splitMessage(""), []);
});

test("divide respetando el máximo y sin perder contenido", () => {
  const text = Array.from({ length: 2000 }, (_, i) => `palabra${i}`).join(" ");
  const parts = splitMessage(text);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 4096);
  assert.equal(parts.join(" ").replace(/\s+/g, " "), text);
});

test("sin espacios corta duro en el límite", () => {
  const parts = splitMessage("a".repeat(10000), 4096);
  assert.deepEqual(parts.map((p) => p.length), [4096, 4096, 1808]);
});

test("keysMatch", () => {
  assert.equal(keysMatch("abc", "abc"), true);
  assert.equal(keysMatch("abd", "abc"), false);
  assert.equal(keysMatch("ab", "abc"), false);
  assert.equal(keysMatch(undefined, "abc"), false);
});
