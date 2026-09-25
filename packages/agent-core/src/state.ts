import type { Message } from "./types.js";
import { chat, type ChatMessage } from "./ollama.js";
import { logger } from "./logger.js";
import { ToolRegistry, ToolExecutor, type ToolResult } from "./tools.js";
import { buildDefaultTools } from "./builtin-tools.js";

/**
 * Estado del agente: "idle" (libre) o "busy" (trabajando en algo).
 */
export type AgentState = "idle" | "busy";

/** Config del loop agéntico. */
const MAX_TOOL_ROUNDS = 5;

/**
 * Estado en memoria del agente.
 *
 * Es un singleton en el proceso: el servidor HTTP consulta/actualiza
 * este objeto para saber si el agente está ocupado o libre.
 */
class AgentStateStore {
  private state: AgentState = "idle";
  private currentTaskId: string | null = null;
  private startedAt: string | null = null;

  get(): {
    state: AgentState;
    currentTaskId: string | null;
    startedAt: string | null;
  } {
    return {
      state: this.state,
      currentTaskId: this.currentTaskId,
      startedAt: this.startedAt,
    };
  }

  isBusy(): boolean {
    return this.state === "busy";
  }

  /** Marca el agente como ocupado con una tarea. */
  startTask(taskId: string): void {
    this.state = "busy";
    this.currentTaskId = taskId;
    this.startedAt = new Date().toISOString();
  }

  /** Marca el agente como libre. */
  finishTask(): void {
    this.state = "idle";
    this.currentTaskId = null;
    this.startedAt = null;
  }
}

/** Instancia única del estado (scope de proceso). */
export const agentState = new AgentStateStore();

/** Catálogo de tools del agente (extensible: registry.register(...)). */
export const toolRegistry: ToolRegistry = buildDefaultTools();
export const toolExecutor = new ToolExecutor(toolRegistry);

/**
 * Loop agéntico: modelo ↔ tools hasta respuesta final.
 *
 * En cada round el modelo puede pedir tool_calls; el executor las
 * valida (schema Zod), las ejecuta y agrega los resultados como
 * mensajes `tool`. Corta cuando el modelo responde sin tool_calls
 * o al agotar MAX_TOOL_ROUNDS.
 */
async function runAgentLoop(
  taskId: string,
  messages: ChatMessage[],
): Promise<{ content: string; model: string; promptEvalCount?: number; evalCount?: number; rounds: number; toolResults: ToolResult[] }> {
  const tools = toolRegistry.toOllamaTools();
  const allToolResults: ToolResult[] = [];

  for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
    const res = await chat(messages, { tools });

    if (!res.toolCalls || res.toolCalls.length === 0) {
      // Respuesta final: el modelo no pidió más tools.
      return { ...res, rounds: round, toolResults: allToolResults };
    }

    // Registrar el pedido del modelo (assistant con tool_calls) en el historial.
    messages.push({
      role: "assistant",
      content: res.content,
      toolCalls: res.toolCalls,
    } as unknown as ChatMessage);

    // Ejecutar cada tool pedida y agregar el resultado como mensaje `tool`.
    for (const call of res.toolCalls) {
      const result = await toolExecutor.execute(
        call.function.name,
        call.function.arguments,
        { userText: messages.find((m) => m.role === "user")?.content ?? "", taskId },
      );

      logger.info("tools", `Tool ejecutada: ${call.function.name}`, {
        ok: result.ok,
        durationMs: result.durationMs,
        error: result.error,
      });
      allToolResults.push(result);

      messages.push({
        role: "tool",
        content: JSON.stringify(result.ok ? result.result : { error: result.error }),
        tool_name: call.function.name,
      } as unknown as ChatMessage);
    }
  }

  // Se agotaron los rounds: forzar respuesta final sin tools.
  logger.warn("agent-core", `MAX_TOOL_ROUNDS (${MAX_TOOL_ROUNDS}) alcanzado en tarea ${taskId}`);
  const final = await chat(messages);
  return { ...final, rounds: MAX_TOOL_ROUNDS, toolResults: allToolResults };
}

/**
 * Procesa un mensaje entrante con el loop agéntico.
 */
export async function handleMessage(message: Message): Promise<void> {
  const taskId = message.id ?? crypto.randomUUID();

  if (agentState.isBusy()) {
    throw new Error("El agente ya está procesando otra tarea");
  }

  agentState.startTask(taskId);
  logger.taskStart(taskId, String(message.chatId), message.text);
  logger.info("agent-core", `Procesando tarea ${taskId}`, {
    chatId: message.chatId,
    text: message.text,
  });

  try {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "Sos un asistente personal autónomo. Respondé de forma clara y concisa en el idioma del usuario. " +
          "Tenés herramientas disponibles; usalas cuando te ayuden a responder mejor.",
      },
      { role: "user", content: message.text },
    ];

    const reply = await runAgentLoop(taskId, messages);

    logger.taskDone(taskId, {
      model: reply.model,
      replyText: reply.content,
      promptTokens: reply.promptEvalCount,
      evalTokens: reply.evalCount,
    });
    logger.info("agent-core", `Tarea ${taskId} completada`, {
      model: reply.model,
      evalCount: reply.evalCount,
      rounds: reply.rounds,
      toolsUsed: reply.toolResults.map((r) => `${r.name}:${r.ok ? "ok" : "error"}`),
    });
  } catch (error) {
    logger.taskFail(taskId, error instanceof Error ? error.message : String(error));
    logger.error("agent-core", `Tarea ${taskId} falló`, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    agentState.finishTask();
  }
}