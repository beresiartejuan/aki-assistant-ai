import { z } from "zod";
import { Agent, type Dispatcher } from "undici";
import { internalAuthHeaders } from "./auth.js";

/**
 * Tool shell: ejecuta comandos de shell en el sandbox del executor.
 *
 * A diferencia de run_command (argv directo), shell corre en modo
 * interpretado para permitir pipes, redirects y encadenamiento
 * (&&, ||, ;). La seguridad sigue garantizada porque:
 * - El executor rechaza binarios de shell "puros" (sh, bash...) como
 *   comando raíz — esta tool usa un wrapper del sandbox.
 * - Todo corre dentro del contenedor Docker sin red, con límite de
 *   RAM y workspace aislado: aunque el shell interprete pipes, no
 *   puede tocar el host.
 *
 * Comandos de directorios (ls, mkdir, rm, mv...) solo afectan al
 * workspace: es el cwd del contenedor y lo único montado (rw).
 */

/** Dispatcher IPv4 (bug de red local con IPv6). */
const dispatcher: Dispatcher = new Agent({
  connect: { family: 4, autoSelectFamily: false },
});

function loadEnv(): NodeJS.ProcessEnv {
  try {
    process.loadEnvFile();
  } catch {
    // sin .env
  }
  return process.env;
}

const EXECUTOR_URL = loadEnv().EXECUTOR_URL ?? "http://localhost:3100";

interface ExecutorResponse {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** Tool de shell segura vía executor. */
export const shell = {
  name: "shell",
  description:
    "Ejecuta un comando de shell dentro de un sandbox Linux aislado (Docker sin red, límite de 2GB RAM, usuario sin privilegios). " +
    "Soporta pipes, redirects y encadenamiento (&&, ||, ;). " +
    "Los archivos solo existen dentro del workspace de la tarea: mkdir, rm, mv, cp etc. afectan únicamente a ese entorno, nunca al sistema real. " +
    "Herramientas disponibles: node, python3, curl, wget, ping, grep, find, sort, awk, sed, tar, gzip, sqlite3, jq, git y coreutils estándar. " +
    "Hay acceso a internet; los archivos solo existen dentro del workspace de la tarea.",
  schema: z.object({
    /** Script de shell a ejecutar. */
    script: z
      .string()
      .min(1)
      .max(10_000)
      .describe(
        "Script de shell a ejecutar, ej: 'cat datos.txt | grep error | wc -l'",
      ),
    /** Timeout opcional en ms (default 15s, max 120s). */
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  }),
  run: async (
    args: { script: string; timeoutMs?: number },
    ctx: { taskId: string },
  ) => {
    const { origin, pathname } = new URL(`${EXECUTOR_URL}/exec`);
    const res = await dispatcher.request({
      origin,
      path: pathname,
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...internalAuthHeaders(),
      },
      body: JSON.stringify({
        taskId: ctx.taskId,
        // El executor solo acepta binarios fuera de la denylist; el modo
        // shell del sandbox expone /usr/bin/sh como entrypoint seguro.
        command: "sandbox-shell",
        args: [args.script],
        timeoutMs: args.timeoutMs,
      }),
    });

    if (res.statusCode !== 200) {
      const body = await res.body.json().catch(() => null);
      throw new Error(
        `executor rechazó el script (HTTP ${res.statusCode}): ${JSON.stringify(body)}`,
      );
    }

    const body = (await res.body.json()) as ExecutorResponse;
    return {
      exitCode: body.exitCode,
      timedOut: body.timedOut,
      stdout: body.stdout,
      stderr: body.stderr,
      durationMs: body.durationMs,
    };
  },
} as const;