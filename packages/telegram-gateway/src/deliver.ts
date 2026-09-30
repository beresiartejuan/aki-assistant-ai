import path from "node:path";
import { config } from "./config.js";
import type { ResultPayload } from "./types.js";
import { ip4Dispatcher } from "./http.js";
import { internalAuthHeaders } from "./auth.js";

/**
 * Entrega de resultados de una tarea al usuario de Telegram:
 * mensaje de texto (respuesta del modelo) + artifacts como documentos.
 */

/**
 * Ruta local absoluta del artifact en el host.
 *
 * El workspace del executor es <EXECUTOR_DATA_DIR>/<taskId>/. La base
 * se resuelve: si GATEWAY_ARTIFACTS_DIR es relativo, se interpreta
 * respecto al directorio de este paquete (para que el default
 * "../executor/data/sandbox" funcione sin importar desde dónde se
 * arranque el proceso).
 */
function localArtifactPath(taskId: string, filePath: string): string {
  const base = path.isAbsolute(config.workspaceBaseDir)
    ? config.workspaceBaseDir
    : path.resolve(PACKAGE_ROOT, config.workspaceBaseDir);
  return path.join(base, taskId, filePath.replace(/^\//, ""));
}

/** Directorio de este paquete (packages/telegram-gateway). */
const PACKAGE_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

/**
 * Sanitiza un filename para uso en multipart/Content-Disposition:
 * elimina comillas, backslashes, CR/LF/NUL y otros caracteres de
 * control (el path puede venir del modelo vía deliver_file).
 */
export function safeFilename(name: string): string {
  const clean = name
    .replace(/[\r\n\0"\\]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();
  return clean || "artifact";
}

/** Descarga un artifact del executor y lo devuelve como Buffer. */
async function fetchArtifact(
  taskId: string,
  filePath: string,
): Promise<{ buffer: Buffer; filename: string } | null> {
  // Defense-in-depth: el path del artifact no debe escapar.
  const clean = filePath.replace(/^\//, "");
  if (clean.startsWith("..") || clean.includes("\0")) return null;

  const url = `${config.executorUrl}/artifacts/${encodeURIComponent(taskId)}/${clean
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

  try {
    const { origin, pathname, search } = new URL(url);
    const res = await ip4Dispatcher.request({
      origin,
      path: `${pathname}${search}`,
      method: "GET",
      headers: internalAuthHeaders(),
    });
    if (res.statusCode !== 200) return null;
    const buffer = Buffer.from(await res.body.arrayBuffer());
    return {
      buffer,
      filename: safeFilename(clean.split("/").pop() ?? "artifact"),
    };
  } catch {
    return null;
  }
}

/** Envía la respuesta de texto al chat. */
async function sendText(chatId: string | number, text: string): Promise<void> {
  const { origin, pathname } = new URL(
    `https://api.telegram.org/bot${config.botToken}/sendMessage`,
  );
  await ip4Dispatcher.request({
    origin,
    path: pathname,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text.slice(0, 4096), // límite de Telegram
    }),
  });
}

/** Envía un archivo como documento con caption. */
async function sendDocument(
  chatId: string | number,
  buffer: Buffer,
  filename: string,
  caption?: string,
): Promise<boolean> {
  const { origin, pathname } = new URL(
    `https://api.telegram.org/bot${config.botToken}/sendDocument`,
  );

  // multipart/form-data a mano (sin dependencias extra).
  const boundary = `----aki${Date.now()}${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];

  const textPart = (name: string, value: string): Buffer =>
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    );

  parts.push(textPart("chat_id", String(chatId)));
  if (caption) parts.push(textPart("caption", caption.slice(0, 1024)));

  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
  );
  parts.push(buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  try {
    const res = await ip4Dispatcher.request({
      origin,
      path: pathname,
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(body.length),
      },
      body,
    });
    await res.body.dump();
    return res.statusCode === 200;
  } catch {
    return false;
  }
}

/**
 * Entrega un resultado completo: texto + artifacts.
 *
 * Es tolerante a fallos: si Telegram falla en un artifact, se sigue
 * con el resto y el texto se manda igual (si puede).
 */
export async function deliverResult(payload: ResultPayload): Promise<void> {
  // 1. Mensaje de texto con la respuesta del modelo.
  if (payload.text) {
    await sendText(payload.chatId, payload.text);
  }

  // 2. Artifacts como documentos.
  for (const artifact of payload.artifacts) {
    if (artifact.size > config.maxArtifactBytes) {
      await sendText(
        payload.chatId,
        `⚠️ El archivo ${artifact.path} supera el límite de Telegram (${formatBytes(
          artifact.size,
        )}) y no pudo enviarse.\n` +
          `Lo encontrás en: ${localArtifactPath(payload.taskId, artifact.path)}`,
      );
      continue;
    }

    const file = await fetchArtifact(payload.taskId, artifact.path);
    if (!file) {
      await sendText(
        payload.chatId,
        `⚠️ No pude recuperar el archivo ${artifact.path}.\n` +
          `Lo encontrás en: ${localArtifactPath(payload.taskId, artifact.path)}`,
      );
      continue;
    }

    const ok = await sendDocument(
      payload.chatId,
      file.buffer,
      file.filename,
      `📄 ${artifact.path} — tarea ${payload.taskId.slice(0, 8)}`,
    );
    if (!ok) {
      console.error(`[gateway] Falló el envío de ${artifact.path} a Telegram`);
      // Aviso con la ruta local para que el usuario no pierda el archivo.
      await sendText(
        payload.chatId,
        `⚠️ No pude enviar ${artifact.path} por Telegram.\n` +
          `Lo encontrás en: ${localArtifactPath(payload.taskId, artifact.path)}`,
      );
    }
  }
}

/** Formatea bytes en KB/MB legibles. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}