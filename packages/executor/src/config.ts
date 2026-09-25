/**
 * Configuración del executor a partir de variables de entorno.
 */

/** Carga .env si existe. */
function loadEnvFile(): void {
  try {
    process.loadEnvFile();
  } catch {
    // Sin .env; solo variables del entorno.
  }
}
loadEnvFile();

export const config = {
  /** Puerto del servidor HTTP. */
  port: Number(process.env.PORT) || 3100,

  /** Directorio raíz del sandbox (workspaces por tarea). */
  sandboxRoot: process.env.EXECUTOR_DATA_DIR ?? "data/sandbox",

  /** Timeout por defecto de un comando (ms). */
  defaultTimeoutMs: Number(process.env.EXECUTOR_DEFAULT_TIMEOUT_MS) || 15_000,

  /** Timeout máximo aceptado por request (ms). */
  maxTimeoutMs: Number(process.env.EXECUTOR_MAX_TIMEOUT_MS) || 120_000,

  /** Máximo de caracteres de stdout+stderr devueltos (truncado si excede). */
  maxOutputChars: Number(process.env.EXECUTOR_MAX_OUTPUT_CHARS) || 10_000,

  /** Máximo de comandos en ejecución simultánea. */
  maxConcurrent: Number(process.env.EXECUTOR_MAX_CONCURRENT) || 4,
} as const;