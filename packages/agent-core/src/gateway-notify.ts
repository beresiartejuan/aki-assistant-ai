import { Agent, type Dispatcher } from "undici";
import { z } from "zod";
import { config } from "./config.js";

/**
 * Notificación de resultados al gateway de Telegram.
 *
 * Al terminar una tarea, agent-core le avisa al gateway con la
 * respuesta del modelo y los artifacts generados. El gateway los
 * entrega al usuario (texto + documentos).
 */

/** Dispatcher IPv4 compartido (bug de red local con IPv6). */
const dispatcher: Dispatcher = new Agent({
  connect: { family: 4, autoSelectFamily: false },
});

/** Artifact en el payload de resultados. */
export interface ArtifactInfo {
  path: string;
  size: number;
}

/** Payload de resultado para el gateway. */
export interface ResultPayload {
  taskId: string;
  chatId: string | number;
  text: string;
  artifacts: ArtifactInfo[];
}

/** Respuesta de GET /artifacts/:taskId del executor. */
const artifactsResponseSchema = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      size: z.number(),
    }),
  ),
});

/** Lista los artifacts generados por una tarea, consultando al executor. */
export async function listArtifacts(taskId: string): Promise<ArtifactInfo[]> {
  try {
    const { origin, pathname } = new URL(`${config.executorUrl}/artifacts/${taskId}`);
    const res = await dispatcher.request({ origin, path: pathname, method: "GET" });
    if (res.statusCode !== 200) return [];

    const body = artifactsResponseSchema.safeParse(await res.body.json());
    return body.success ? body.data.files : [];
  } catch {
    return []; // executor caído: la notificación igual va sin artifacts
  }
}

/**
 * Notifica al gateway el resultado de una tarea.
 * No lanza: es best-effort (el resultado también queda en los logs).
 */
export async function notifyResult(payload: ResultPayload): Promise<boolean> {
  try {
    const { origin, pathname } = new URL(`${config.gatewayUrl}/results`);
    const res = await dispatcher.request({
      origin,
      path: pathname,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    await res.body.dump();
    return res.statusCode === 202;
  } catch (error) {
    console.error("[agent-core] No se pudo notificar al gateway:", error);
    return false;
  }
}