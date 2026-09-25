/**
 * Embeddings vía Ollama LOCAL (http://127.0.0.1:11434/api/embed).
 *
 * La capa semántica usa un modelo de embeddings chico y local (ej:
 * qwen3-embedding:0.6b, 1024 dims) para no depender de la nube en el
 * camino crítico del retrieval. IPv4 forzado por el bug de red del host.
 */
import { Agent, type Dispatcher } from "undici";
import { config } from "./config.js";

/** Dispatcher IPv4 dedicado (mismo fix que ollama.ts). */
const dispatcher: Dispatcher = new Agent({
  connect: { family: 4, autoSelectFamily: false },
});

interface EmbedResponse {
  embeddings?: number[][];
  error?: string;
}

/** Dimensión esperada de los vectores según el modelo configurado. */
export const EMBED_DIM = config.embedDim;

/** Genera el embedding de un texto con el modelo configurado (Ollama local). */
export async function embed(text: string): Promise<number[]> {
  const res = await dispatcher.request({
    origin: config.embedBaseUrl,
    path: "/api/embed",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: config.embedModel, input: text }),
  });
  const body = (await res.body.json()) as EmbedResponse;
  if (res.statusCode !== 200 || !body.embeddings?.[0]) {
    throw new Error(`embed fallo (${res.statusCode}): ${JSON.stringify(body).slice(0, 200)}`);
  }
  const vec = body.embeddings[0];
  if (vec.length !== EMBED_DIM) {
    throw new Error(`embed dims=${vec.length}, esperaba ${EMBED_DIM}`);
  }
  return vec;
}