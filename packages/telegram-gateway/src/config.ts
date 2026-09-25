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

  /** URL base del servidor HTTP de agent-core. */
  agentCoreUrl: process.env.AGENT_CORE_URL ?? "http://localhost:3000",

  /** Directorio donde se persiste la cola de mensajes pendientes. */
  dataDir: process.env.GATEWAY_DATA_DIR ?? "data",

  /** Intervalo base de sondeo del dispatcher (ms) cuando la cola tiene mensajes. */
  dispatchPollIntervalMs: Number(process.env.GATEWAY_DISPATCH_POLL_MS) || 1000,

  /** Backoff máximo entre reintentos tras errores de red (ms). */
  maxBackoffMs: Number(process.env.GATEWAY_MAX_BACKOFF_MS) || 30_000,
} as const;