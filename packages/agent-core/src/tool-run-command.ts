import { z } from "zod";
import { Agent, type Dispatcher } from "undici";

/**
 * Tool run_command: delega la ejecución al servicio executor.
 *
 * El executor (paquete @aki/executor) corre como servicio aparte con su
 * propio sandbox: workspace por tarea, denylist de comandos, env mínimo,
 * timeout con SIGTERM→SIGKILL y límite de salida. Esta tool solo le
 * habla por HTTP y devuelve el resultado al modelo.
 */

/** Dispatcher IPv4 (bug de red local con IPv6). */
const dispatcher: Dispatcher = new Agent({
  connect: { family: 4, autoSelectFamily: false },
});

/** Config mínima (lee .env del agent-core). */
function env(): Record<string, string | undefined> {
  try {
    process.loadEnvFile();
  } catch {
    // sin .env
  }
  return process.env;
}

const EXECUTOR_URL = env().EXECUTOR_URL ?? "http://localhost:3100";

/** Respuesta del executor. */
interface ExecutorResponse {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

/** Tool de ejecución de comandos vía servicio executor. */
export const runCommand = {
  name: "run_command",
  description:
    "Ejecuta un comando en un sandbox Linux aislado (workspace propio por tarea). " +
    "Ideal para cálculos con node, manipular archivos, inspeccionar datos, etc. " +
    "Comandos peligrosos (sudo, reboot, etc.) son rechazados. " +
    "Hay acceso a internet: curl, wget y fetch funcionan. " +
    "No hay shell: pasá el binario y sus argumentos por separado.",
  schema: z.object({
    /** Comando a ejecutar (argv, sin shell). */
    command: z.string().min(1).describe("Binario a ejecutar, ej: node, python3, ls"),
    /** Argumentos del comando. */
    args: z.array(z.string()).default([]).describe("Argumentos del comando"),
    /** Timeout opcional en ms (default 15s, max 120s). */
    timeoutMs: z.number().int().positive().optional(),
  }),
  run: async (args: { command: string; args: string[]; timeoutMs?: number }, ctx: { taskId: string }) => {
    const { origin, pathname } = new URL(`${EXECUTOR_URL}/exec`);
    const res = await dispatcher.request({
      origin,
      path: pathname,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: ctx.taskId,
        command: args.command,
        args: args.args,
        timeoutMs: args.timeoutMs,
      }),
    });

    if (res.statusCode !== 200) {
      const body = await res.body.json().catch(() => null);
      throw new Error(
        `executor rechazó el comando (HTTP ${res.statusCode}): ${JSON.stringify(body)}`,
      );
    }

    const body = (await res.body.json()) as ExecutorResponse;

    // Formato compacto para que el modelo lea bien el resultado.
    return {
      exitCode: body.exitCode,
      timedOut: body.timedOut,
      stdout: body.stdout,
      stderr: body.stderr,
      durationMs: body.durationMs,
    };
  },
} as const;