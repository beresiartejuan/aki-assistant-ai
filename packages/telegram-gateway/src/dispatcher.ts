import type { QueuedMessage } from "./types.js";
import type { PersistentQueue } from "./queue.js";
import { postJson } from "./http.js";
import { config } from "./config.js";

/** Resultado de intentar enviar el primer mensaje de la cola. */
export type DispatchResult = "sent" | "busy" | "retry" | "dropped";

/**
 * Envía mensajes de la cola a agent-core vía HTTP.
 *
 * Comportamiento por intento:
 * - 202 → enviado; se saca de la cola.
 * - 409 (agent ocupado) → se conserva en la cola y se reintenta luego.
 * - error de red / 5xx → se reintenta con backoff exponencial.
 * - 4xx distinto de 409 → payload inválido; se descarta (no tiene
 *   sentido reintentar para siempre).
 */
export class Dispatcher {
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly queue: PersistentQueue) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(0);
    console.log("[gateway] Dispatcher iniciado");
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log("[gateway] Dispatcher detenido");
  }

  /** Programa el próximo ciclo de despacho. */
  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.dispatchOnce();
    }, delayMs);
  }

  /** Un ciclo: intenta enviar el primer mensaje de la cola, si hay. */
  private async dispatchOnce(): Promise<void> {
    let nextDelay = config.dispatchPollIntervalMs;

    try {
      const head = this.queue.peek();
      if (head !== undefined) {
        const result = await this.trySend(head);
        switch (result) {
          case "sent":
            await this.queue.dequeue();
            nextDelay = 0; // drenar la cola rápido
            break;
          case "busy":
            nextDelay = config.dispatchPollIntervalMs;
            break;
          case "retry":
            nextDelay = this.backoffFor(head);
            await this.queue.markAttempt();
            break;
          case "dropped":
            await this.queue.dequeue();
            nextDelay = 0;
            break;
        }
      }
    } catch (error) {
      console.error("[gateway] Error inesperado en dispatcher:", error);
    }

    this.scheduleNext(nextDelay);
  }

  /** Intenta enviar un mensaje a agent-core. */
  private async trySend(message: QueuedMessage): Promise<DispatchResult> {
    try {
      const { status } = await postJson(`${config.agentCoreUrl}/messages`, message);

      if (status === 202) {
        console.log(`[gateway] Mensaje ${message.id} aceptado por agent-core`);
        return "sent";
      }
      if (status === 409) {
        return "busy";
      }
      if (status >= 500) {
        console.error(`[gateway] agent-core devolvió ${status}; se reintentará`);
        return "retry";
      }
      console.error(
        `[gateway] agent-core rechazó el mensaje ${message.id} con ${status}; se descarta`,
      );
      return "dropped";
    } catch (error) {
      console.error("[gateway] Error de red enviando a agent-core:", error);
      return "retry";
    }
  }

  /** Backoff exponencial: 1s, 2s, 4s... hasta maxBackoffMs. */
  private backoffFor(message: QueuedMessage): number {
    const backoff = Math.min(
      config.maxBackoffMs,
      config.dispatchPollIntervalMs * 2 ** message.attempts,
    );
    return backoff;
  }
}