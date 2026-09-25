import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { fileURLToPath } from "node:url";
import { messageSchema } from "./types.js";
import { agentState, handleMessage } from "./state.js";
import { logger } from "./logger.js";

const app = new Hono();

/**
 * GET /status
 * Indica si el agente está trabajando en algo o está libre.
 */
app.get("/status", (c) => {
  const { state, currentTaskId, startedAt } = agentState.get();
  return c.json({
    state,
    busy: agentState.isBusy(),
    currentTaskId,
    startedAt,
  });
});

/**
 * POST /messages
 * Recibe un mensaje para ser procesado por el agente.
 *
 * Las tareas son pesadas/largas, así que la respuesta es 202 Accepted:
 * el mensaje quedó aceptado y el procesamiento corre en background.
 * Si el agente ya está ocupado responde 409 Conflict con el estado actual.
 */
app.post("/messages", async (c) => {
  if (agentState.isBusy()) {
    const { currentTaskId, startedAt } = agentState.get();
    return c.json(
      {
        error: "agent_busy",
        message: "El agente está procesando otra tarea",
        currentTaskId,
        startedAt,
      },
      409,
    );
  }

  const raw = await c.req.json().catch(() => null);
  const parsed = messageSchema.safeParse(raw);

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

  // El procesamiento corre en background; no bloquea la respuesta.
  void handleMessage(parsed.data).catch((error) => {
    logger.error("http", "Error procesando mensaje", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  logger.info("http", "Mensaje aceptado", { id: parsed.data.id });
  return c.json({ accepted: true }, 202);
});

/** Ruta no encontrada. */
app.notFound((c) => c.json({ error: "not_found" }, 404));

/** Manejador global de errores. */
app.onError((error, c) => {
  logger.error("http", "Error no manejado", {
    error: error instanceof Error ? error.message : String(error),
    path: c.req.path,
  });
  return c.json({ error: "internal_error" }, 500);
});

export function startServer(port = Number(process.env.PORT) || 3000) {
  logger.init();
  logger.info("http", `Servidor HTTP escuchando en http://localhost:${port}`);
  const server = serve({ fetch: app.fetch, port });

  // Cierre graceful: liberar la BD de logs.
  const close = () => {
    logger.info("http", "Cerrando servidor");
    logger.close();
    server.close();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);

  return server;
}

// Si el módulo se ejecuta directamente (src con tsx o dist compilado),
// levantamos el servidor.
const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === fileURLToPath(`file://${process.argv[1]}`);
if (isDirectRun) {
  startServer();
}