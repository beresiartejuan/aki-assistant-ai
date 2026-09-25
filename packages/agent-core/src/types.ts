import { z } from "zod";

/** Esquema del mensaje que llega al agente. */
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