import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SecurityError,
  assertCommandAllowed,
  assertHostModeAllowed,
  assertRealPathInside,
  buildEnv,
  dockerArgsFor,
  resolveInsideWorkspace,
  workspaceDir,
} from "./security.js";

const denied = (fn: () => unknown) => assert.throws(fn, SecurityError);

test("denylist: binarios peligrosos, con ruta y barra final", () => {
  for (const c of ["bash", "/bin/bash", "/usr//bin/sh", "bash/", "sudo", "kill", "dd"]) {
    denied(() => assertCommandAllowed(c, []));
  }
  denied(() => assertCommandAllowed("a\0b", []));
  assert.doesNotThrow(() => assertCommandAllowed("ls", ["-la"]));
});

test("denylist de args: absolutos y traversal", () => {
  for (const a of ["/etc", "/etc/passwd", "../x", "a/../../b", "./../x", ".."]) {
    denied(() => assertCommandAllowed("cat", [a]));
  }
  assert.doesNotThrow(() => assertCommandAllowed("cat", ["file..txt", "dir/file.txt", "s/a/b/"]));
});

test("modo host: sin intérpretes ni rutas", () => {
  denied(() => assertHostModeAllowed("python3", []));
  denied(() => assertHostModeAllowed("/usr/bin/node", []));
  denied(() => assertHostModeAllowed("./x", []));
  assert.doesNotThrow(() => assertHostModeAllowed("ls", []));
});

test("taskId con traversal es rechazado", () => {
  for (const id of ["..", "a/b", "a\\b", "../x", "a\0"]) denied(() => workspaceDir(id));
});

test("buildEnv: filtra claves peligrosas", () => {
  const env = buildEnv({ FOO: "1", PATH: "/evil", LD_PRELOAD: "x", LD_LIBRARY_PATH: "x", BASH_ENV: "x", "A B": "x", HOME: "/root" });
  assert.equal(env.FOO, "1");
  assert.notEqual(env.PATH, "/evil");
  for (const k of ["LD_PRELOAD", "LD_LIBRARY_PATH", "BASH_ENV", "A B"]) assert.equal(env[k], undefined);
  assert.notEqual(env.HOME, "/root");
});

test("dockerArgsFor: hardening y name", () => {
  const a = dockerArgsFor({
    image: "img", hostWorkspace: "/w", memory: 1, cpus: 0, networkMode: "none",
    env: { A: "b" }, command: "ls", args: ["-l"], name: "n1",
  });
  for (const f of ["--read-only", "--cap-drop", "no-new-privileges", "--pids-limit", "--name"]) {
    assert.ok(a.includes(f), f);
  }
  assert.deepEqual(a.slice(-3), ["img", "ls", "-l"].slice(0, 3));
});

test("assertRealPathInside / resolveInsideWorkspace con symlinks reales", async () => {
  const root = await mkdtemp(join(tmpdir(), "exec-sec-"));
  try {
    const ws = join(root, "ws");
    const outside = join(root, "outside");
    await mkdir(join(ws, "sub"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "secret"), "x");
    await symlink(outside, join(ws, "link"));
    await symlink(join(outside, "secret"), join(ws, "flink"));

    await assertRealPathInside(ws, join(ws, "sub"));
    await assertRealPathInside(ws, join(ws, "sub", "nuevo", "f.txt")); // inexistente
    await assert.rejects(assertRealPathInside(ws, join(ws, "link")), SecurityError);
    await assert.rejects(assertRealPathInside(ws, join(ws, "link", "x", "y")), SecurityError);
    await assert.rejects(assertRealPathInside(ws, join(ws, "flink")), SecurityError);
    await assert.rejects(assertRealPathInside(ws, outside), SecurityError);

    // baseDir a través de un symlink no debe dar falso positivo.
    const alias = join(root, "alias");
    await symlink(ws, alias);
    await assertRealPathInside(alias, join(alias, "sub"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveInsideWorkspace: traversal, absolutos y symlinks", async () => {
  const { config } = await import("./config.js");
  const root = await mkdtemp(join(tmpdir(), "exec-ws-"));
  const mutable = config as { sandboxRoot: string };
  const prev = mutable.sandboxRoot;
  mutable.sandboxRoot = root;
  try {
    const ws = workspaceDir("t1");
    await mkdir(join(ws, "ok", "..dir"), { recursive: true });
    await symlink(tmpdir(), join(ws, "esc"));
    assert.equal(await resolveInsideWorkspace("t1"), ws);
    assert.equal(await resolveInsideWorkspace("t1", "ok"), join(ws, "ok"));
    assert.equal(await resolveInsideWorkspace("t1", "ok/..dir"), join(ws, "ok", "..dir"));
    for (const c of ["..", "../t2", "ok/../..", "/etc", "esc", "esc/x"]) {
      await assert.rejects(resolveInsideWorkspace("t1", c), SecurityError, c);
    }
  } finally {
    mutable.sandboxRoot = prev;
    await rm(root, { recursive: true, force: true });
  }
});
