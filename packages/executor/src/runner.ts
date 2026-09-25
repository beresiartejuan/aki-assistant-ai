import { spawn } from "node:child_process";
import { config } from "./config.js";
import type { CommandRequest, CommandResult } from "./types.js";
import {
  SecurityError,
  assertCommandAllowed,
  resolveInsideWorkspace,
  ensureWorkspace,
  buildEnv,
} from "./security.js";

/**
 * Ejecutor de comandos en sandbox.
 *
 * - argv directo con shell: false (no hay shell injection).
 * - cwd dentro del workspace de la tarea (resolución estricta).
 * - env mínimo (no hereda el proceso).
 * - timeout con SIGTERM → grace → SIGKILL.
 * - stdout/stderr capturados con límite de tamaño.
 * - concurrencia limitada (cola simple).
 */
export class CommandRunner {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor() {
    // noop; config se lee en cada ejecución (testable).
  }

  /** Slot disponible inmediato o espera a que se libere. */
  private async acquire(): Promise<() => void> {
    if (this.running < config.maxConcurrent) {
      this.running++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.running--;
        const next = this.queue.shift();
        if (next) next();
      };
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve(() => {
          this.running--;
          const next = this.queue.shift();
          if (next) next();
        });
      });
    });
  }

  /** Ejecuta un comando en el workspace de la tarea. */
  async run(req: CommandRequest): Promise<CommandResult> {
    const release = await this.acquire();
    try {
      return await this.runUnsafe(req);
    } finally {
      release();
    }
  }

  private async runUnsafe(req: CommandRequest): Promise<CommandResult> {
    // 1. Validación de seguridad (denylist, traversal).
    assertCommandAllowed(req.command, req.args);

    // 2. Workspace de la tarea; creación idempotente.
    await ensureWorkspace(req.taskId);
    const cwd = resolveInsideWorkspace(req.taskId, req.cwd);

    // 3. Timeout efectivo (clamp al máximo).
    const timeoutMs = Math.min(req.timeoutMs ?? config.defaultTimeoutMs, config.maxTimeoutMs);

    const start = Date.now();
    const child = spawn(req.command, req.args, {
      cwd,
      env: buildEnv(req.env),
      shell: false, // argv directo, sin shell
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    const max = config.maxOutputChars;

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < max) stdout += chunk.toString("utf8");
      else truncated = true;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < max) stderr += chunk.toString("utf8");
      else truncated = true;
    });

    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      // Grace: SIGTERM y luego SIGKILL si no murió.
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, timeoutMs);

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("error", (error) => {
        // spawn falló (binario inexistente, permisos): devolver como stderr.
        stderr += `\n[executor] spawn error: ${error.message}`;
        resolve({ code: -1, signal: null });
      });
      child.on("close", (code, signal) => resolve({ code, signal }));
    });

    clearTimeout(killTimer);

    return {
      taskId: req.taskId,
      command: req.command,
      args: req.args,
      exitCode: result.code,
      signal: result.signal,
      stdout: truncate(stdout, max),
      stderr: truncate(stderr, max),
      timedOut,
      truncated,
      durationMs: Date.now() - start,
    };
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncado ${text.length - max} chars]`;
}

export { SecurityError };