import { z } from "zod";

/** Request de ejecución de comando. */
export const commandRequestSchema = z.object({
  /** Id de la tarea/workspace: aisla el directorio de trabajo. */
  taskId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  /** Comando a ejecutar (sin shell, argv directo). */
  command: z.string().min(1),
  /** Argumentos, argv directo. */
  args: z.array(z.string().max(2000)).max(50).default([]),
  /** Timeout en ms (opcional). */
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  /** Variables de entorno extra (se filtran por allowlist). */
  env: z.record(z.string(), z.string()).optional(),
  /** cwd relativo dentro del workspace (ej: "subdir"). */
  cwd: z.string().max(500).optional(),
});

export type CommandRequest = z.infer<typeof commandRequestSchema>;

/** Respuesta de ejecución de comando. */
export interface CommandResult {
  taskId: string;
  command: string;
  args: string[];
  exitCode: number | null;
  /** Señal con la que murió el proceso (ej: SIGKILL por timeout). */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** true si el proceso murió por timeout. */
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}