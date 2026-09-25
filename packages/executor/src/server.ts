import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { config } from "./config.js";
import { commandRequestSchema } from "./types.js";
import { CommandRunner } from "./runner.js";
import { SecurityError, workspaceDir } from "./security.js";

const app = new Hono();
const runner = new CommandRunner();

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