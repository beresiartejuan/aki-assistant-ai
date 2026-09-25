import { join } from "node:path";
import { config } from "./config.js";
import { PersistentQueue } from "./queue.js";
import { Dispatcher } from "./dispatcher.js";
import { createBot, startBot } from "./telegram.js";
import { startResultsServer } from "./server.js";
import { deliverResult } from "./deliver.js";
import type { ResultPayload } from "./types.js";

/**
 * Punto de entrada del gateway de Telegram:
 * 1. Carga la cola persistente desde disco.
 * 2. Arranca el dispatcher (envía mensajes a agent-core vía HTTP).
 * 3. Arranca el servidor de resultados (POST /results desde agent-core).
 * 4. Arranca el bot de Telegram con long polling (requiere IPv4 forzado).
 */
async function main(): Promise<void> {
  const queue = new PersistentQueue(
    join(process.cwd(), config.dataDir, "pending.json"),
  );
  await queue.load();
  if (queue.size > 0) {
    console.log(`[gateway] Cola restaurada con ${queue.size} mensaje(s) pendiente(s)`);
  }

  const dispatcher = new Dispatcher(queue);
  dispatcher.start();

  // Cuando agent-core notifica un resultado, se entrega por Telegram.
  startResultsServer((payload: ResultPayload) => {
    console.log(`[gateway] Resultado recibido para tarea ${payload.taskId}`);
    void deliverResult(payload).catch((error) => {
      console.error("[gateway] Error entregando resultado:", error);
    });
  });

  const bot = createBot(queue);

  const stop = () => {
    dispatcher.stop();
    void bot.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await startBot(bot);
}

main().catch((error) => {
  console.error("[gateway] Error fatal:", error);
  process.exit(1);
});