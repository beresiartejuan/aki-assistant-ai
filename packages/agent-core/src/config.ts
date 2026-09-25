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

  /** Puerto del servidor HTTP. */
  port: Number(process.env.PORT) || 3000,
} as const;