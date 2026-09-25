/**
 * Cliente HTTP del executor para archivos del workspace (notas del
 * agente). El executor expone POST/GET /files/:taskId/:path con
 * anti-traversal y límite de tamaño.
 */
import { Agent } from "undici";
import { config } from "./config.js";

/** Dispatcher IPv4 (mismo fix que ollama.ts). */
const dispatcher: Agent = new Agent({
  connect: { family: 4, autoSelectFamily: false },
});

/** Escribe un archivo de texto en el workspace de la tarea. */
export async function writeSandboxFile(taskId: string, path: string, content: string): Promise<void> {
  const encoded = path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const res = await dispatcher.request({
    origin: config.executorUrl,
    path: `/files/${encodeURIComponent(taskId)}/${encoded}`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (res.statusCode !== 200) {
    await res.body.text().catch(() => "");
    throw new Error(`writeSandboxFile fallo (${res.statusCode})`);
  }
  await res.body.text().catch(() => "");
}

/** Lee un archivo de texto del workspace de la tarea (null si no existe). */
export async function readSandboxFile(taskId: string, path: string): Promise<{ content: string } | null> {
  const encoded = path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  const res = await dispatcher.request({
    origin: config.executorUrl,
    path: `/files/${encodeURIComponent(taskId)}/${encoded}`,
    method: "GET",
  });
  if (res.statusCode === 404) return null;
  if (res.statusCode !== 200) {
    await res.body.text().catch(() => "");
    throw new Error(`readSandboxFile fallo (${res.statusCode})`);
  }
  const body = (await res.body.json()) as { content?: string };
  return { content: body.content ?? "" };
}