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

  /** Máximo de rondas del loop agéntico (modelo <-> tools). */
  maxToolRounds: Number(process.env.AGENT_MAX_TOOL_ROUNDS) || 15,

  /**
   * Máximo de segmentos de continuación. Si el agente agota las rondas
   * de un segmento y sigue necesitando tools, retoma automáticamente
   * hasta este número de segmentos (15 rondas x 3 segmentos = 45 rondas
   * máximas por defecto).
   */
  maxAgentSegments: Number(process.env.AGENT_MAX_SEGMENTS) || 3,

  /** Puerto del servidor HTTP. */
  port: Number(process.env.PORT) || 3000,

  // ── Memoria (capas 1-4) ──────────────────────────────────────────────

  /** URL de Ollama LOCAL para embeddings de la capa semántica. */
  embedBaseUrl: process.env.OLLAMA_LOCAL_URL ?? "http://127.0.0.1:11434",

  /** Modelo de embeddings local. */
  embedModel: process.env.OLLAMA_EMBED_MODEL ?? "qwen3-embedding:0.6b",

  /** Dimensión de los vectores del modelo de embeddings. */
  embedDim: Number(process.env.OLLAMA_EMBED_DIM) || 1024,

  /**
   * TTL de la capa semántica: aprendizajes sin reconfirmación dentro
   * de este rango (días) se descartan en la próxima consolidación.
   */
  memoryTtlDays: Number(process.env.MEMORY_TTL_DAYS) || 30,

  /** Episodios previos inyectados al contexto al iniciar una tarea. */
  memoryEpisodesInContext: Number(process.env.MEMORY_EPISODES_IN_CONTEXT) || 8,

  /** Máximo de aprendizajes semánticos por retrieval (top-K). */
  memorySemanticTopK: Number(process.env.MEMORY_SEMANTIC_TOP_K) || 5,

  /** Máximo de hechos del sistema inyectados al contexto. */
  memoryFactsInContext: Number(process.env.MEMORY_FACTS_IN_CONTEXT) || 30,
} as const;