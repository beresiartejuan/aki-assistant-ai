import { z } from "zod";

/**
 * Esquema del mensaje enviado a agent-core (POST /messages).
 * Debe mantenerse en sincronía con el de @aki/agent-core.
 */
export const messageSchema = z.object({
  id: z.string().min(1).optional(),
  chatId: z.union([z.string(), z.number()]),
  text: z.string().min(1),
  /** Identificador del remitente (ej: usuario de Telegram). */
  from: z.string().min(1).optional(),
  /** Marca de tiempo ISO 8601 opcional. */
  receivedAt: z.iso.datetime().optional(),
});

export type Message = z.infer<typeof messageSchema>;

/** Mensaje encolado, con metadatos de reintento. */
export interface QueuedMessage extends Message {
  /** ISO 8601: cuándo se encoló. */
  enqueuedAt: string;
  /** Cantidad de intentos de envío fallidos hasta ahora. */
  attempts: number;
}