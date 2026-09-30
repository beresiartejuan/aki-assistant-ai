import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { config } from "./config.js";
import { resultPayloadSchema, type ResultPayload } from "./types.js";
import { requireInternalKey } from "./auth.js";

/**
 * Servidor HTTP del gateway.
 *
 * Expone POST /results: agent-core notifica aquí cuando una tarea
 * termina, y el gateway entrega la respuesta + artifacts al usuario
 * de Telegram.
 */
export function createResultsApp(
  onResult: (payload: ResultPayload) => void,
): Hono {
  const app = new Hono();

  // Auth inter-servicios: exige el shared secret (x-internal-key) si
  // INTERNAL_API_KEY está configurado. GET /status queda libre para
  // health-checks.
  app.use("/results", requireInternalKey());

  app.post("/results", async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = resultPayloadSchema.safeParse(raw);

    if (!parsed.success) {
      return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    }

    onResult(parsed.data);

    // La entrega corre en background: responder rápido a agent-core.
    return c.json({ ok: true }, 202);
  });

  app.get("/status", (c) =>
    c.json({
      ok: true,
      botConfigured: Boolean(config.botToken),
      port: config.port,
    }),
  );

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  return app;
}

export function startResultsServer(
  onResult: (payload: ResultPayload) => void,
  port = config.port,
) {
  const server = serve({ fetch: createResultsApp(onResult).fetch, port, hostname: config.bindHost });
  console.log(`[gateway] Servidor de resultados escuchando en http://${config.bindHost}:${port}`);
  return server;
}