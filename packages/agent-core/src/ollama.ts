import { Agent, type Dispatcher } from "undici";
import { config } from "./config.js";

/**
 * Dispatcher HTTP que fuerza IPv4 en todas las conexiones,
 * para esquivar el bug de IPv6 de la red local del host.
 */
export const ip4Dispatcher: Dispatcher = new Agent({
  connect: { family: 4, autoSelectFamily: false },
});

/** Mensaje de conversación para la API de Ollama. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Respuesta de la API /api/chat de Ollama. */
interface OllamaChatResponse {
  model: string;
  message: {
    role: string;
    content: string;
    thinking?: string;
  };
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

/** Error al llamar a la API de Ollama. */
export class OllamaError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "OllamaError";
  }
}

/**
 * Invoca un modelo en Ollama Cloud (endpoint /api/chat).
 *
 * Usa el dispatcher IPv4 y autentica con `Authorization: Bearer`.
 * Devuelve el contenido final del assistant (el campo `thinking`
 * del modelo de razonamiento no se expone).
 */
export async function chat(
  messages: ChatMessage[],
  options: { model?: string } = {},
): Promise<{ content: string; model: string; promptEvalCount?: number; evalCount?: number }> {
  if (!config.ollamaApiKey) {
    throw new OllamaError("OLLAMA_API_KEY no está definida");
  }

  const model = options.model ?? config.ollamaModel;
  const res = await ip4Dispatcher.request({
    origin: config.ollamaBaseUrl,
    path: "/api/chat",
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.ollamaApiKey}`,
    },
    body: JSON.stringify({ model, messages, stream: false }),
  });

  const body = (await res.body.json()) as OllamaChatResponse;

  if (res.statusCode !== 200) {
    throw new OllamaError(
      `Ollama devolvió ${res.statusCode}: ${JSON.stringify(body)}`,
      res.statusCode,
    );
  }

  const content = body.message?.content ?? "";
  if (!content) {
    throw new OllamaError("Ollama devolvió una respuesta vacía");
  }

  return {
    content,
    model: body.model,
    promptEvalCount: body.prompt_eval_count,
    evalCount: body.eval_count,
  };
}