import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistentQueue } from "./queue.js";

const msg = (n: number) => ({
  id: `m${n}`,
  chatId: "1",
  text: `t${n}`,
  from: "u",
  receivedAt: new Date().toISOString(),
});

async function tmpFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "q-")), "sub", "pending.json");
}

test("FIFO, dedupe y persistencia entre instancias", async () => {
  const f = await tmpFile();
  const q = new PersistentQueue(f);
  await q.load();
  await q.enqueue(msg(1));
  await q.enqueue(msg(1));
  await q.enqueue(msg(2));
  assert.equal(q.size, 2);
  await q.markAttempt();
  const q2 = new PersistentQueue(f);
  await q2.load();
  assert.equal(q2.size, 2);
  assert.equal(q2.peek()?.id, "m1");
  assert.equal(q2.peek()?.attempts, 1);
  assert.equal((await q2.dequeue())?.id, "m1");
  assert.equal(q2.peek()?.id, "m2");
});

test("escrituras concurrentes no fallan y el disco queda consistente", async () => {
  const f = await tmpFile();
  const q = new PersistentQueue(f);
  await q.load();
  await Promise.all(Array.from({ length: 50 }, (_, i) => q.enqueue(msg(i))));
  await Promise.all([q.markAttempt(), q.dequeue(), q.enqueue(msg(99))]);
  const onDisk = JSON.parse(await readFile(f, "utf8"));
  assert.equal(onDisk.length, q.size);
  assert.equal(q.size, 50);
});

test("archivo corrupto arranca vacío", async () => {
  const f = await tmpFile();
  const q0 = new PersistentQueue(f);
  await q0.load();
  await q0.enqueue(msg(1));
  await writeFile(f, "{no json", "utf8");
  const q = new PersistentQueue(f);
  await q.load();
  assert.equal(q.size, 0);
  await q.enqueue(msg(2));
  assert.equal(q.size, 1);
});

test("JSON que no es array o con items inválidos", async () => {
  const f = await tmpFile();
  const q0 = new PersistentQueue(f);
  await q0.load();
  await q0.enqueue(msg(1));
  await writeFile(f, '{"a":1}', "utf8");
  const q = new PersistentQueue(f);
  await q.load();
  assert.equal(q.size, 0);
  await writeFile(f, JSON.stringify([{ foo: 1 }, { id: "x", chatId: "1", text: "hi", attempts: 0 }]), "utf8");
  const q2 = new PersistentQueue(f);
  await q2.load();
  assert.equal(q2.size, 1);
});
