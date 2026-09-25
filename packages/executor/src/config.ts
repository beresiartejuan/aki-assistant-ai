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

/** Modo de ejecución del sandbox. */
export type SandboxMode = "docker" | "process";

export const config = {
  /** Puerto del servidor HTTP. */
  port: Number(process.env.PORT) || 3100,

  /**
   * Modo del sandbox:
   * - "docker": cada comando corre en un contenedor efímero (recomendado).
   * - "process": ejecución directa en el host (fallback para desarrollo).
   */
  sandboxMode: (process.env.EXECUTOR_SANDBOX_MODE as SandboxMode) || "docker",

  /**
   * Directorio raíz del sandbox (workspaces por tarea, montado al
   * contenedor). Acepta ruta relativa (al directorio del paquete) o
   * absoluta (ej: /home/usuario/agent-workspaces).
   */
  sandboxRoot: process.env.EXECUTOR_DATA_DIR ?? "data/sandbox",

  /** Imagen Docker del sandbox. */
  sandboxImage: process.env.EXECUTOR_SANDBOX_IMAGE ?? "aki-sandbox:latest",

  /**
   * Modo de red del contenedor:
   * - "none": sin red (por defecto hasta ahora).
   * - "bridge": red Docker default (NAT, acceso a internet y a la red
   *   del host vía su IP).
   * - "host": usa la pila de red del host directamente.
   */
  networkMode: process.env.EXECUTOR_NETWORK_MODE ?? "bridge",

  /** Límite de RAM por contenedor (bytes): 2GB. */
  containerMemoryLimit:
    Number(process.env.EXECUTOR_CONTAINER_MEMORY) || 2 * 1024 * 1024 * 1024,

  /** CPUs asignadas al contenedor (opcional, 0 = sin límite). */
  containerCpus: Number(process.env.EXECUTOR_CONTAINER_CPUS) || 0,

  /** Timeout por defecto de un comando (ms). */
  defaultTimeoutMs: Number(process.env.EXECUTOR_DEFAULT_TIMEOUT_MS) || 15_000,

  /** Timeout máximo aceptado por request (ms). */
  maxTimeoutMs: Number(process.env.EXECUTOR_MAX_TIMEOUT_MS) || 120_000,

  /** Máximo de caracteres de stdout+stderr devueltos (truncado si excede). */
  maxOutputChars: Number(process.env.EXECUTOR_MAX_OUTPUT_CHARS) || 10_000,

  /** Máximo de comandos en ejecución simultánea. */
  maxConcurrent: Number(process.env.EXECUTOR_MAX_CONCURRENT) || 4,
} as const;