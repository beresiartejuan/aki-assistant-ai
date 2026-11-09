import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { ToolRegistry, ToolExecutor, ToolError, type Tool } from "./tools.js";

const ctx = { userText: "", taskId: "t1" };
const echo: Tool<{ text: string; n: number }> = {
  name: "echo",
  description: "eco",
  schema: z.object({ text: z.string().min(1), n: z.number().int().default(1) }),
  run: async (a) => ({ out: a.text.repeat(a.n) }),
};

test("registry: valida nombres y duplicados", () => {
  const r = new ToolRegistry();
  assert.throws(() => r.register({ ...echo, name: "BadName" }), ToolError);
  r.register(echo);
  assert.throws(() => r.register(echo), /duplicado/);
  assert.deepEqual(r.names(), ["echo"]);
});

test("toOllamaTools serializa a JSON Schema", () => {
  const [t] = new ToolRegistry().register(echo).toOllamaTools();
  assert.equal(t.type, "function");
  assert.equal(t.function.name, "echo");
  const params = t.function.parameters as any;
  assert.equal(params.type, "object");
  assert.ok(params.properties.text);
});

test("executor: ejecuta con args válidos y aplica defaults", async () => {
  const ex = new ToolExecutor(new ToolRegistry().register(echo));
  const r = await ex.execute("echo", { text: "ab", n: 2 }, ctx);
  assert.deepEqual([r.ok, r.result], [true, { out: "abab" }]);
  const d = await ex.execute("echo", { text: "z" }, ctx);
  assert.deepEqual(d.result, { out: "z" });
});

test("executor: args inválidos, tool desconocida y errores de run no lanzan", async () => {
  const boom: Tool<{}> = { name: "boom", description: "", schema: z.object({}), run: async () => { throw new ToolError("fallo"); } };
  const ex = new ToolExecutor(new ToolRegistry().registerAll([echo, boom]));
  const bad = await ex.execute("echo", { text: "" }, ctx);
  assert.ok(!bad.ok && /Argumentos inválidos/.test(bad.error!));
  const unk = await ex.execute("nope", {}, ctx);
  assert.ok(!unk.ok && /desconocido/.test(unk.error!));
  const b = await ex.execute("boom", undefined, ctx);
  assert.deepEqual([b.ok, b.error], [false, "fallo"]);
});
