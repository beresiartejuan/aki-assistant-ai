import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Message, QueuedMessage } from "./types.js";

/**
 * Cola FIFO persistente en disco.
 *
 * Los mensajes pendientes de enviar a agent-core se guardan en un archivo
 * JSON con escritura atómica (tmp + rename), de modo que si el proceso
 * se cae, al reiniciar se retoma la cola donde quedó.
 */
export class PersistentQueue {
  private items: QueuedMessage[] = [];
  private loaded = false;

  constructor(private readonly filePath: string) {}

  /** Carga la cola desde el disco. Idempotente. */
  async load(): Promise<void> {
    if (this.loaded) return;

    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      // El archivo aún no existe: cola vacía.
      this.items = [];
      this.loaded = true;
      return;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("la cola no es un array");
      // Validación ligera de forma.
      this.items = parsed.filter(
        (item): item is QueuedMessage =>
          typeof item === "object" &&
          item !== null &&
          "id" in item &&
          "chatId" in item &&
          "text" in item,
      );
    } catch (error) {
      console.error("[gateway] Cola corrupta, se descarta y arranca vacía:", error);
      this.items = [];
    }
    this.loaded = true;
  }

  get size(): number {
    return this.items.length;
  }

  /** Primer mensaje pendiente (FIFO). */
  peek(): QueuedMessage | undefined {
    return this.items[0];
  }

  /** Agrega un mensaje al final de la cola. Ignora duplicados por id. */
  async enqueue(message: Message): Promise<void> {
    const id = message.id ?? crypto.randomUUID();
    if (this.items.some((item) => item.id === id)) {
      return; // ya está encolado
    }
    this.items.push({
      ...message,
      id,
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
    });
    await this.persist();
  }

  /** Quita el primer mensaje de la cola (enviado con éxito). */
  async dequeue(): Promise<QueuedMessage | undefined> {
    const [head] = this.items;
    if (head === undefined) return undefined;
    this.items.shift();
    await this.persist();
    return head;
  }

  /** Registra un intento fallido del primer mensaje (para backoff). */
  async markAttempt(): Promise<void> {
    const head = this.items[0];
    if (head === undefined) return;
    head.attempts += 1;
    await this.persist();
  }

  /** Persiste la cola con escritura atómica: escribe tmp y renombra. */
  private async persist(): Promise<void> {
    const tmp = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(tmp, JSON.stringify(this.items, null, 2), "utf8");
    await rename(tmp, this.filePath);
  }
}