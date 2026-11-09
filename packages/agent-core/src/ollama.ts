import { Agent, type Dispatcher } from "undici";
import { config } from "./config.js";

/**
 * Dispatcher HTTP que fuerza IPv4 en todas las conexiones,
 * para esquivar el bug de IPv6 de la red local del host.
 */
export const ip4Dispatcher: Dispatcher = new Agent({
  connect: { family: 4, autoSelectFamily: false },
  // stream:false => los headers llegan al terminar la generación.
  headersTimeout: config.ollamaTimeoutMs,
  bodyTimeout: config.ollamaTimeoutMs,
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

/** true si la URL apunta a esta misma máquina (Ollama local). */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/** Headers de la petición; `authorization` solo si hay API key. */
export function buildHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

/** 429 y 5xx se reintentan; el resto de 4xx no. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Backoff exponencial: base * 2^attempt (attempt arranca en 0). */
export function backoffDelayMs(attempt: number, baseMs: number): number {
  return baseMs * 2 ** attempt;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Convierte el mensaje interno al formato de la API (tool_calls). */
function toWireMessage(m: ChatMessage): Record<string, unknown> {
  const { toolCalls, ...rest } = m;
  return toolCalls && toolCalls.length > 0 ? { ...rest, tool_calls: toolCalls } : rest;
}

/**
 * Invoca un modelo de Ollama (endpoint /api/chat).
 *
 * Usa el dispatcher IPv4. La API key es obligatoria solo para hosts
 * remotos (en localhost Ollama proxea los modelos :cloud). Aplica
 * timeout y reintentos con backoff exponencial ante 429/5xx/errores de
 * red; los 4xx no se reintentan. Devuelve el contenido final del
 * assistant (el campo `thinking` no se expone).
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
  if (!config.ollamaApiKey && !isLocalUrl(config.ollamaBaseUrl)) {
    throw new OllamaError("OLLAMA_API_KEY no está definida (obligatoria para hosts remotos)");
  }

  const model = options.model ?? config.ollamaModel;
  const payload: Record<string, unknown> = {
    model,
    messages: messages.map(toWireMessage),
    stream: false,
  };
  if (options.tools && options.tools.length > 0) {
    payload.tools = options.tools;
  }
  const requestBody = JSON.stringify(payload);
  const headers = buildHeaders(config.ollamaApiKey);

  let body: OllamaChatResponse | undefined;
  for (let attempt = 0; ; attempt++) {
    let failure: OllamaError;
    let retryable = true;
    try {
      const res = await ip4Dispatcher.request({
        origin: config.ollamaBaseUrl,
        path: "/api/chat",
        method: "POST",
        headers,
        body: requestBody,
        signal: AbortSignal.timeout(config.ollamaTimeoutMs),
      });
      const text = await res.body.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // cuerpo no JSON (ej: HTML de un proxy): se reporta como texto
      }
      if (res.statusCode === 200 && typeof parsed === "object" && parsed !== null) {
        body = parsed as OllamaChatResponse;
        break;
      }
      retryable = isRetryableStatus(res.statusCode);
      failure = new OllamaError(
        `Ollama devolvió ${res.statusCode}: ${(typeof parsed === "string" ? parsed : JSON.stringify(parsed)).slice(0, 500)}`,
        res.statusCode,
      );
    } catch (error) {
      failure = new OllamaError(
        `Error de red/timeout llamando a Ollama: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!retryable || attempt >= config.ollamaMaxRetries) throw failure;
    await sleep(backoffDelayMs(attempt, config.ollamaRetryBaseMs));
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
