import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, isAbsolute } from "node:path";
import { config } from "./config.js";
import { commandRequestSchema } from "./types.js";
import { CommandRunner } from "./runner.js";
import { SecurityError, workspaceDir } from "./security.js";

const app = new Hono();
const runner = new CommandRunner();

/** MIME types mínimos para servir artifacts. */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
};

function mimeFor(path: string): string {
  const ext = (extname(path) || "").toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

function extname(p: string): string {
  const base = p.split("/").pop() ?? p;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
}

/**
 * Resuelve un path relativo dentro del workspace de la tarea.
 * Lanza SecurityError si escapa (traversal).
 */
function resolveArtifactPath(taskId: string, filePath: string): string {
  if (filePath.includes("\0")) {
    throw new SecurityError("Ruta inválida");
  }
  const workspace = workspaceDir(taskId);
  const resolved = isAbsolute(filePath)
    ? join(workspace, filePath)
    : join(workspace, filePath);
  const rel = relative(workspace, resolved);
  if (rel.startsWith("..") || isAbsolute(rel) || rel === "") {
    throw new SecurityError(`Ruta fuera del workspace: ${filePath}`);
  }
  return resolved;
}

/**
 * GET /artifacts/:taskId
 * Lista los archivos generados por una tarea.
 */
app.get("/artifacts/:taskId", async (c) => {
  const taskId = c.req.param("taskId");
  if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) {
    return c.json({ error: "invalid_task_id" }, 400);
  }

  try {
    const dir = workspaceDir(taskId);
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    const files: Array<{ path: string; size: number; modifiedAt: string }> = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = join(dir, entry.parentPath.replace(dir, ""), entry.name);
      const info = await stat(full);
      files.push({
        path: relative(dir, full),
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
      });
    }

    return c.json({ taskId, files });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return c.json({ error: "task_not_found" }, 404);
    }
    throw error;
  }
});

/**
 * GET /artifacts/:taskId/:path{.*}
 * Descarga un archivo del workspace (con Content-Type según extensión).
 */
app.get("/artifacts/:taskId/:path{.+}", async (c) => {
  const taskId = c.req.param("taskId");
  const filePath = c.req.param("path");
  if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) {
    return c.json({ error: "invalid_task_id" }, 400);
  }

  try {
    const full = resolveArtifactPath(taskId, filePath);
    const content = await readFile(full);
    return c.body(
      new Uint8Array(content),
      200,
      {
        "Content-Type": mimeFor(filePath),
        "Content-Disposition": `inline; filename="${(filePath.split("/").pop() ?? "file").replace(/"/g, "")}"`,
      },
    );
  } catch (error) {
    if (error instanceof SecurityError) {
      return c.json({ error: "security_rejected", message: error.message }, 403);
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return c.json({ error: "artifact_not_found" }, 404);
    }
    throw error;
  }
});

/** Límite de tamaño para la API de archivos (notas del agente). */
const MAX_FILE_BYTES = 64 * 1024;

/**
 * POST /files/:taskId/:path{.+}
 * Escribe un archivo de texto dentro del workspace de la tarea.
 *
 * Pensado para notas del agente (ej: .agent/scratchpad.md), no para
 * artifacts de trabajo: el body es {"content": "..."} con límite de
 * tamaño. La escritura crea directorios intermedios.
 */
app.post("/files/:taskId/:path{.+}", async (c) => {
  const taskId = c.req.param("taskId");
  const filePath = c.req.param("path");
  if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) {
    return c.json({ error: "invalid_task_id" }, 400);
  }

  const body = await c.req.json().catch(() => null);
  const content = (body as { content?: unknown } | null)?.content;
  if (typeof content !== "string") {
    return c.json({ error: "invalid_body", message: "content debe ser string" }, 400);
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_FILE_BYTES) {
    return c.json({ error: "too_large", message: `Máximo ${MAX_FILE_BYTES} bytes` }, 413);
  }

  try {
    const full = resolveArtifactPath(taskId, filePath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
    return c.json({ ok: true, path: filePath, bytes });
  } catch (error) {
    if (error instanceof SecurityError) {
      return c.json({ error: "security_rejected", message: error.message }, 403);
    }
    throw error;
  }
});

/**
 * GET /files/:taskId/:path{.+}
 * Lee un archivo de texto del workspace como JSON {"content": "..."}.
 */
app.get("/files/:taskId/:path{.+}", async (c) => {
  const taskId = c.req.param("taskId");
  const filePath = c.req.param("path");
  if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) {
    return c.json({ error: "invalid_task_id" }, 400);
  }

  try {
    const full = resolveArtifactPath(taskId, filePath);
    const content = await readFile(full, "utf8");
    return c.json({ ok: true, path: filePath, content });
  } catch (error) {
    if (error instanceof SecurityError) {
      return c.json({ error: "security_rejected", message: error.message }, 403);
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return c.json({ error: "file_not_found" }, 404);
    }
    throw error;
  }
});

/**
 * POST /exec
 * Ejecuta un comando en el workspace de la tarea.
 */
app.post("/exec", async (c) => {
  const raw = await c.req.json().catch(() => null);
  const parsed = commandRequestSchema.safeParse(raw);

  if (!parsed.success) {
    return c.json(
      {
        error: "invalid_body",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      400,
    );
  }

  try {
    const result = await runner.run(parsed.data);
    return c.json(result, 200);
  } catch (error) {
    if (error instanceof SecurityError) {
      return c.json({ error: "security_rejected", message: error.message }, 403);
    }
    console.error("[executor] Error inesperado:", error);
    return c.json({ error: "internal_error" }, 500);
  }
});

/**
 * GET /status
 * Concurrencia y configuración del sandbox.
 */
app.get("/status", (c) => {
  return c.json({
    ok: true,
    sandboxRoot: workspaceDir(""),
    maxConcurrent: config.maxConcurrent,
    defaultTimeoutMs: config.defaultTimeoutMs,
    maxOutputChars: config.maxOutputChars,
  });
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((error, c) => {
  console.error("[executor] Error no manejado:", error);
  return c.json({ error: "internal_error" }, 500);
});

export function startServer(port = config.port) {
  console.log(`[executor] Servidor HTTP escuchando en http://localhost:${port}`);
  const server = serve({ fetch: app.fetch, port });

  const close = () => {
    console.log("[executor] Cerrando servidor");
    server.close();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);

  return server;
}

// Si el módulo se ejecuta directamente (src con tsx o dist compilado),
// levanta el servidor.
const isDirectRun =
  process.argv[1]?.endsWith("src/server.ts") ||
  process.argv[1]?.endsWith("dist/server.js");
if (isDirectRun) {
  startServer();
}