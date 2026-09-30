/**
 * Configuración del gateway de Telegram a partir de variables de entorno.
 */

/** Carga .env si existe (Node >= 20.12 soporta loadEnvFile). */
function loadEnvFile(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No hay archivo .env; se usan solo variables del entorno.
  }
}
loadEnvFile();

export const config = {
  /** Token del bot de Telegram. */
  botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",

  /**
   * Allowlist de usuarios de Telegram (ids numéricos, separados por coma).
   * Vacío = SOLO desarrollo inseguro: acepta todo (comportamiento actual).
   * Con al menos un id, cualquier mensaje de otro usuario se ignora y se
   * registra en el log con su id para poder permitirlo después.
   */
  allowedUserIds: (process.env.ALLOWED_TELEGRAM_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean) as string[],

  /** URL base del servidor HTTP de agent-core. */
  agentCoreUrl: process.env.AGENT_CORE_URL ?? "http://localhost:3000",

  /** URL base del executor (para descargar artifacts). */
  executorUrl: process.env.EXECUTOR_URL ?? "http://localhost:3100",

  /**
   * Directorio base de workspaces del executor (mismo valor que
   * EXECUTOR_DATA_DIR del executor). Se usa para informar al usuario
   * la ruta local de un archivo cuando no se puede enviar por Telegram.
   * Es relativo al directorio del paquete si no es absoluto.
   */
  workspaceBaseDir: process.env.GATEWAY_ARTIFACTS_DIR ?? "../executor/data/sandbox",

  /** Puerto del servidor HTTP del gateway (recibe resultados de agent-core). */
  port: Number(process.env.GATEWAY_PORT) || 3200,

  /**
   * Interfaz de red del servidor HTTP. Loopback por defecto; solo
   * cambiar si los servicios corren en hosts separados.
   */
  bindHost: process.env.BIND_HOST ?? "127.0.0.1",

  /** Tamaño máximo de artifact a enviar por Telegram (50 MB del Bot API). */
  maxArtifactBytes: 49 * 1024 * 1024,

  /** Directorio donde se persiste la cola de mensajes pendientes. */
  dataDir: process.env.GATEWAY_DATA_DIR ?? "data",

  /** Intervalo base de sondeo del dispatcher (ms) cuando la cola tiene mensajes. */
  dispatchPollIntervalMs: Number(process.env.GATEWAY_DISPATCH_POLL_MS) || 1000,

  /** Backoff máximo entre reintentos tras errores de red (ms). */
  maxBackoffMs: Number(process.env.GATEWAY_MAX_BACKOFF_MS) || 30_000,

  /**
   * Al arrancar, descarta el backlog de updates pendientes: los mensajes
   * acumulados mientras el gateway estuvo apagado se ignoran y el
   * checkpoint queda en el último update como si ya hubiera sido
   * leído/respondido. Desactivar con GATEWAY_SKIP_BACKLOG=false.
   */
  skipBacklogOnStart: process.env.GATEWAY_SKIP_BACKLOG !== "false",
} as const;