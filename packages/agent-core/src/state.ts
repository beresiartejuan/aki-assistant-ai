import type { Message } from "./types.js";
import { chat, type ChatMessage } from "./ollama.js";
import { logger } from "./logger.js";
import { config } from "./config.js";
import { ToolRegistry, ToolExecutor, type ToolResult } from "./tools.js";
import { buildDefaultTools } from "./builtin-tools.js";
import { listArtifacts, notifyResult } from "./gateway-notify.js";
import { memory, getConstitution } from "./memory.js";
import { consolidateMemory } from "./consolidate.js";
import { searchLearnings } from "./semantic.js";
import { SCRATCHPAD_PATH } from "./memory-tools.js";

/**
 * Estado del agente: "idle" (libre) o "busy" (trabajando en algo).
 */
export type AgentState = "idle" | "busy";

/** Config del loop agéntico. */
const MAX_TOOL_ROUNDS = config.maxToolRounds;
/** Máximo de segmentos de continuación (cada uno con MAX_TOOL_ROUNDS rondas). */
const MAX_SEGMENTS = config.maxAgentSegments;

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

/** Registro de entregables de una tarea. */
function createDeliverables() {
  const set = new Set<string>();
  return {
    add(path: string): void {
      set.add(path);
    },
    has(path: string): boolean {
      return set.has(path);
    },
    list(): string[] {
      return [...set];
    },
  };
}

/**
 * Loop agéntico con continuación automática.
 *
 * Cada "segmento" permite hasta MAX_TOOL_ROUNDS rondas modelo↔tools.
 * Si el segmento se agota y el modelo sigue necesitando tools, en vez
 * de forzar una respuesta cortada:
 *  1. se notifica al usuario un mensaje de progreso (si corresponde),
 *  2. se continúa con un nuevo segmento retomando el mismo historial
 *     + un nudge del sistema, hasta un total de MAX_SEGMENTS segmentos.
 *
 * El loop solo corta con respuesta final (sin tool_calls) o al agotar
 * los segmentos.
 */
async function runAgentLoop(
  taskId: string,
  messages: ChatMessage[],
  deliverables: ReturnType<typeof createDeliverables>,
  opts: { onSegmentEnd?: () => void | Promise<void> } = {},
): Promise<{ content: string; model: string; promptEvalCount?: number; evalCount?: number; rounds: number; toolResults: ToolResult[] }> {
  const tools = toolRegistry.toOllamaTools();
  const allToolResults: ToolResult[] = [];
  let totalRounds = 0;

  for (let segment = 1; segment <= MAX_SEGMENTS; segment++) {
    let exhausted = false;

    for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
      totalRounds++;
      const res = await chat(messages, { tools });

      if (!res.toolCalls || res.toolCalls.length === 0) {
        // Respuesta final: el modelo no pidió más tools.
        return { ...res, rounds: totalRounds, toolResults: allToolResults };
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
          { userText: messages.find((m) => m.role === "user")?.content ?? "", taskId, deliverables },
        );

        logger.info("tools", `Tool ejecutada: ${call.function.name}`, {
          ok: result.ok,
          durationMs: result.durationMs,
          error: result.error,
        });

        // Capa 2 (episódico, append-only): registrar cada acción con su
        // resultado para que tareas futuras puedan recordar qué funcionó.
        memory.appendEpisode(
          taskId,
          "tool",
          `${call.function.name}(${JSON.stringify(call.function.arguments).slice(0, 200)}) -> ${result.ok ? "ok" : `ERROR: ${(result.error ?? "").slice(0, 200)}`}`,
          result.ok,
        );
        allToolResults.push(result);

        messages.push({
          role: "tool",
          content: JSON.stringify(result.ok ? result.result : { error: result.error }),
          tool_name: call.function.name,
        } as unknown as ChatMessage);
      }
    }
    exhausted = true;

    // Segmento agotado y el modelo sigue pidiendo tools: continuar.
    logger.warn(
      "agent-core",
      `Segmento ${segment}/${MAX_SEGMENTS} agotado (${MAX_TOOL_ROUNDS} rondas) en tarea ${taskId}; continuando`,
    );
    await opts.onSegmentEnd?.();

    // Nudge: el sistema retoma el trabajo sin re-empezar. Reinyecta el
    // scratchpad (capa 1) para que no pierda el hilo entre segmentos.
    let scratchpad = "";
    try {
      const sp = await import("./sandbox-files.js");
      const res = await sp.readSandboxFile(taskId, SCRATCHPAD_PATH);
      scratchpad = res?.content ?? "";
    } catch {
      // sin scratchpad: continuar igual
    }
    messages.push({
      role: "user",
      content:
        `[sistema] Continuá la tarea desde donde quedaste (segmento ${segment + 1} de ${MAX_SEGMENTS}). ` +
        `No repitas pasos ya hechos ni pidas permiso: seguí trabajando hacia el objetivo original. ` +
        `Si el objetivo ya está cumplido, respondé el resultado final sin llamar herramientas.` +
        (scratchpad ? `\n\n# Tu scratchpad actual (capa 1)\n${scratchpad}` : ""),
    });

    void exhausted;
  }

  // Se agotaron todos los segmentos: forzar respuesta final sin tools.
  logger.error(
    "agent-core",
    `MAX_SEGMENTS (${MAX_SEGMENTS}) agotados (${totalRounds} rondas) en tarea ${taskId}; forzando respuesta final`,
  );
  const final = await chat(messages);
  return { ...final, rounds: totalRounds, toolResults: allToolResults };
}

/**
 * Procesa un mensaje entrante con el loop agéntico.
 */
export async function handleMessage(message: Message, taskIdOverride?: string): Promise<void> {
  const taskId = taskIdOverride ?? message.id ?? crypto.randomUUID();

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
    // ── Consolidación de memoria (best-effort, nunca bloquea) ──────
    try {
      await consolidateMemory();
    } catch {
      // ya logueado dentro
    }

    // ── Construcción del contexto de memoria ───────────────────────
    // Regla: nunca se tira todo al prompt. Constitución (capa 0) +
    // hechos actuales (capa 4, acotados) + últimos episodios de tareas
    // anteriores (capa 2, acotados) + top-K semántico (capa 3).
    const constitution = getConstitution();

    const facts = memory.getFact().slice(0, config.memoryFactsInContext);
    const factsBlock = facts.length
      ? "\n\n# Hechos del sistema (versionados)\n" +
        facts.map((f) => `- ${f.key} = ${f.value} (v${f.version})`).join("\n")
      : "";

    const recentEpisodes = memory.recentEpisodes(
      config.memoryEpisodesInContext,
      taskId,
    );
    const episodesBlock = recentEpisodes.length
      ? "\n\n# Últimas acciones de tareas anteriores\n" + recentEpisodes.map((e) => `- [${e.ts.slice(0, 16)}] ${e.text}`).join("\n")
      : "";

    let semanticBlock = "";
    try {
      const learnings = await searchLearnings(message.text, config.memorySemanticTopK);
      if (learnings.length > 0) {
        semanticBlock =
          "\n\n# Aprendizajes relevantes (memoria de largo plazo)\n" +
          learnings.map((l) => `- ${l.text}`).join("\n");
      }
    } catch {
      // Ollama local caído o LanceDB indisponible: seguir sin capa 3.
    }

    const systemPrompt =
      "Sos un asistente personal autónomo. Respondé de forma clara y concisa en el idioma del usuario. " +
      "Tenés herramientas disponibles; usalas cuando te ayuden a responder mejor.\n\n" +
      "Entorno de ejecución (sandbox): tenés un workspace propio y persistente por tarea en /workspace. " +
      "Los archivos y las instalaciones (npm install dentro de /workspace) PERSISTEN entre llamadas de " +
      "herramientas de la misma tarea, así que podés hacer procesos de varios pasos: instalar dependencias " +
      "en un paso y usarlas en el siguiente. Tenés tiempo para hasta 15 rondas de herramientas por segmento, " +
      "con segmentos de continuación; si una tarea es compleja, descomponela en pasos y seguí trabajando sin " +
      "pedir permiso.\n\n" +
      "Entrega de archivos: cuando generes un archivo que el usuario pidió ver (informes, imágenes, PDFs, " +
      "etc.), marcálo con la tool deliver_file. NO entregues archivos de trabajo interno que el usuario no " +
      "pidió." +
      (constitution ? `\n\n# Constitución (reglas de prioridad máxima)\n${constitution}` : "") +
      factsBlock +
      episodesBlock +
      semanticBlock;

    const deliverables = createDeliverables();
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: systemPrompt,
      },
      { role: "user", content: message.text },
    ];

    const reply = await runAgentLoop(taskId, messages, deliverables, {
      // Al cortar un segmento, avisar progreso al usuario (best-effort).
      onSegmentEnd: async () => {
        const chatIdStr = String(message.chatId);
        if (!chatIdStr || chatIdStr === "test") return;
        try {
          await notifyResult({
            taskId,
            chatId: message.chatId,
            text: "⏳ Seguí trabajando en tu pedido (tarea larga, no hiciste nada). Cuando termine te mando el resultado.",
            artifacts: [],
          });
        } catch {
          // best-effort: no abortar la tarea por un fallo de notificación
        }
      },
    });

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

    // Notificar al gateway (respuesta + artifacts) si el mensaje tiene
    // un chatId real (vino de Telegram, no de un test directo).
    const chatIdStr = String(message.chatId);
    if (chatIdStr && chatIdStr !== "test") {
      // Solo los archivos que el agente marcó con deliver_file.
      const marked = deliverables.list();
      const artifacts = await listArtifacts(taskId);
      const toDeliver = marked.length
        ? artifacts.filter((a) => marked.includes(a.path))
        : []; // si no marcó nada, no se manda ningún archivo

      const delivered = await notifyResult({
        taskId,
        chatId: message.chatId,
        text: reply.content,
        artifacts: toDeliver,
      });
      logger.info("agent-core", `Resultado notificado al gateway`, {
        taskId,
        delivered,
        artifactsMarked: marked.length,
        artifactsDelivered: toDeliver.length,
      });
    }
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