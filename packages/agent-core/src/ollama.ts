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
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Nombre de la tool que produjo este mensaje (solo role: tool). */
  tool_name?: string;
  /** Llamadas a tools pedidas por el modelo (solo role: assistant). */
  toolCalls?: Array<{
    function: {
      name: string;
      arguments: Record<string, unknown>;
    };
  }>;
}

/** Definición de tool en formato Ollama/OpenAI. */
export interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Respuesta de la API /api/chat de Ollama. */
interface OllamaChatResponse {
  model: string;
  message: {
    role: string;
    content: string;
    thinking?: string;
    tool_calls?: Array<{
      function: {
        name: string;
        arguments: Record<string, unknown>;
      };
    }>;
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
  options: { model?: string; tools?: OllamaTool[] } = {},
): Promise<{
  content: string;
  model: string;
  promptEvalCount?: number;
  evalCount?: number;
  toolCalls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}> {
  if (!config.ollamaApiKey) {
    throw new OllamaError("OLLAMA_API_KEY no está definida");
  }

  const model = options.model ?? config.ollamaModel;
  const payload: Record<string, unknown> = { model, messages, stream: false };
  if (options.tools && options.tools.length > 0) {
    payload.tools = options.tools;
  }
  const res = await ip4Dispatcher.request({
    origin: config.ollamaBaseUrl,
    path: "/api/chat",
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.ollamaApiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const body = (await res.body.json()) as OllamaChatResponse;

  if (res.statusCode !== 200) {
    throw new OllamaError(
      `Ollama devolvió ${res.statusCode}: ${JSON.stringify(body)}`,
      res.statusCode,
    );
  }

  const message = body.message ?? { role: "assistant", content: "" };
  const content = message.content ?? "";
  const toolCalls = message.tool_calls;

  // Los modelos de razonamiento devuelven content: "\n" cuando piden
  // una tool (el texto real va en `thinking`). Solo es un error si no
  // hay contenido NI tool_calls.
  if (!content.trim() && !(toolCalls && toolCalls.length > 0)) {
    throw new OllamaError(
      `Ollama devolvió una respuesta vacía (thinking: ${message.thinking?.slice(0, 100) ?? "sin thinking"})`,
    );
  }

  return {
    content,
    model: body.model,
    promptEvalCount: body.prompt_eval_count,
    evalCount: body.eval_count,
    toolCalls,
  };
}