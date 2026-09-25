import type { Message } from "./types.js";
import { chat } from "./ollama.js";

/**
 * Estado del agente: "idle" (libre) o "busy" (trabajando en algo).
 */
export type AgentState = "idle" | "busy";

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

/**
 * Procesa un mensaje entrante.
 *
 * TODO: acá va la lógica real de razonamiento del agente. Por ahora
 * es un stub que simula una tarea pesada/larga.
 */
export async function handleMessage(message: Message): Promise<void> {
  const taskId = message.id ?? crypto.randomUUID();

  if (agentState.isBusy()) {
    throw new Error("El agente ya está procesando otra tarea");
  }

  agentState.startTask(taskId);

  try {
    console.log(`[agent-core] Procesando tarea ${taskId}: "${message.text}"`);

    // Razonamiento con el modelo de Ollama Cloud.
    const reply = await chat([
      {
        role: "system",
        content:
          "Sos un asistente personal autónomo. Respondé de forma clara y concisa en el idioma del usuario.",
      },
      { role: "user", content: message.text },
    ]);
    console.log(
      `[agent-core] Tarea ${taskId} completada (${reply.model}, ${reply.evalCount ?? "?"} tokens): "${reply.content.slice(0, 80)}"`,
    );
  } finally {
    agentState.finishTask();
  }
}