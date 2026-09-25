import { spawn } from "node:child_process";
import { config } from "./config.js";
import type { CommandRequest, CommandResult } from "./types.js";
import {
  SecurityError,
  assertCommandAllowed,
  resolveInsideWorkspace,
  ensureWorkspace,
  buildEnv,
  dockerArgsFor,
} from "./security.js";

/**
 * Ejecutor de comandos en sandbox.
 *
 * Dos modos (config.sandboxMode):
 * - "docker": spawn de `docker run` con la imagen del sandbox, workspace
 *   montado como volume y límites de RAM/CPU. Aislamiento real.
 * - "process": ejecución directa en el host con workspace enjaulado y
 *   denylist (fallback de desarrollo, sin Docker).
 *
 * Común: argv directo (sin shell), timeout SIGTERM→SIGKILL, límite de
 * salida, concurrencia limitada (cola simple).
 */
export class CommandRunner {
  private running = 0;
  private queue: Array<() => void> = [];

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

  /** Ejecuta un comando en el sandbox configurado. */
  async run(req: CommandRequest): Promise<CommandResult> {
    const release = await this.acquire();
    try {
      return config.sandboxMode === "docker"
        ? await this.runDocker(req)
        : await this.runProcess(req);
    } finally {
      release();
    }
  }

  /** Modo docker: cada comando en un contenedor efímero con límites. */
  private async runDocker(req: CommandRequest): Promise<CommandResult> {
    assertCommandAllowed(req.command, req.args);

    // El workspace de la tarea se monta en /workspace del contenedor.
    await ensureWorkspace(req.taskId);
    const hostWorkspace = resolveInsideWorkspace(req.taskId, req.cwd ?? undefined);

    // docker run con límites de recursos y auto-eliminación.
    const dockerArgs = dockerArgsFor({
      image: config.sandboxImage,
      hostWorkspace,
      memory: config.containerMemoryLimit,
      cpus: config.containerCpus,
      networkMode: config.networkMode,
      env: buildEnv(req.env),
      command: req.command,
      args: req.args,
      userCwd: req.cwd,
    });

    const timeoutMs = Math.min(req.timeoutMs ?? config.defaultTimeoutMs, config.maxTimeoutMs);
    const start = Date.now();

    // El contenedor corre como root del docker (mapeado a sandbox uid 1000
    // dentro de la imagen); docker CLI del host lo lanza.
    const child = spawn("docker", dockerArgs, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const out = await collectOutput(child, timeoutMs, config.maxOutputChars);
    return finishResult(req, out, start);
  }

  /** Modo process: ejecución directa en el host (fallback de desarrollo). */
  private async runProcess(req: CommandRequest): Promise<CommandResult> {
    assertCommandAllowed(req.command, req.args);

    await ensureWorkspace(req.taskId);
    const cwd = resolveInsideWorkspace(req.taskId, req.cwd);
    const timeoutMs = Math.min(req.timeoutMs ?? config.defaultTimeoutMs, config.maxTimeoutMs);

    const start = Date.now();
    const child = spawn(req.command, req.args, {
      cwd,
      env: buildEnv(req.env),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const out = await collectOutput(child, timeoutMs, config.maxOutputChars);
    return finishResult(req, out, start);
  }
}

interface RawOutput {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

/** Captura stdout/stderr con límite y aplica timeout con SIGTERM→SIGKILL. */
function collectOutput(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  maxChars: number,
): Promise<RawOutput> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < maxChars) stdout += chunk.toString("utf8");
      else truncated = true;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < maxChars) stderr += chunk.toString("utf8");
      else truncated = true;
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, timeoutMs);

    child.on("error", (error) => {
      stderr += `\n[executor] spawn error: ${error.message}`;
      resolve({ code: -1, signal: null, stdout, stderr, truncated, timedOut });
    });

    child.on("close", (code, signal) => {
      clearTimeout(killTimer);
      resolve({ code, signal, stdout, stderr, truncated, timedOut });
    });
  });
}

/** Construye el CommandResult final a partir del output crudo. */
function finishResult(
  req: CommandRequest,
  out: RawOutput,
  start: number,
): CommandResult {
  return {
    taskId: req.taskId,
    command: req.command,
    args: req.args,
    exitCode: out.code,
    signal: out.signal,
    stdout: truncate(out.stdout, config.maxOutputChars),
    stderr: truncate(out.stderr, config.maxOutputChars),
    timedOut: out.timedOut,
    truncated: out.truncated,
    durationMs: Date.now() - start,
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncado ${text.length - max} chars]`;
}

export { SecurityError };