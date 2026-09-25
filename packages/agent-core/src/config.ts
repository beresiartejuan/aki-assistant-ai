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
  /** Clave de la API de Ollama Cloud (obligatoria). */
  ollamaApiKey: process.env.OLLAMA_API_KEY ?? "",

  /** URL base de la API de Ollama Cloud. */
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "https://ollama.com",

  /** Modelo a usar en el razonamiento del agente. */
  ollamaModel: process.env.OLLAMA_MODEL ?? "nemotron-3-nano:30b",

  /** URL del gateway para notificar resultados (vacío = no notificar). */
  gatewayUrl: process.env.GATEWAY_URL ?? "http://localhost:3200",

  /** URL del executor para listar artifacts de la tarea. */
  executorUrl: process.env.EXECUTOR_URL ?? "http://localhost:3100",

  /** Puerto del servidor HTTP. */
  port: Number(process.env.PORT) || 3000,
} as const;