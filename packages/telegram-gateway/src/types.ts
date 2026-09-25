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

/** Artifact generado por una tarea (archivo del workspace). */
export const artifactSchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
});

/** Payload que agent-core envía al gateway al terminar una tarea. */
export const resultPayloadSchema = z.object({
  taskId: z.string().min(1),
  chatId: z.union([z.string(), z.number()]),
  /** Respuesta final del modelo (se envía como mensaje de texto). */
  text: z.string().max(8000),
  /** Archivos generados, para enviarlos como documentos. */
  artifacts: z
    .array(artifactSchema)
    .max(20)
    .default([]),
});

export type ResultPayload = z.infer<typeof resultPayloadSchema>;