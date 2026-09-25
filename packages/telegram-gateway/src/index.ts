import { join } from "node:path";
import { config } from "./config.js";
import { PersistentQueue } from "./queue.js";
import { Dispatcher } from "./dispatcher.js";
import { createBot, startBot, withCheckpoint, UpdateCheckpoint } from "./telegram.js";
import { startResultsServer } from "./server.js";
import { deliverResult } from "./deliver.js";
import type { ResultPayload } from "./types.js";

/**
 * Punto de entrada del gateway de Telegram:
 * 1. Carga la cola persistente desde disco.
 * 2. Carga el checkpoint del último update_id procesado.
 * 3. Arranca el dispatcher (envía mensajes a agent-core vía HTTP).
 * 4. Arranca el servidor de resultados (POST /results desde agent-core).
 * 5. Arranca el bot de Telegram con long polling (IPv4 forzado),
 *    continuando desde el último update confirmado.
 */
async function main(): Promise<void> {
  const queue = new PersistentQueue(
    join(process.cwd(), config.dataDir, "pending.json"),
  );
  await queue.load();
  if (queue.size > 0) {
    console.log(`[gateway] Cola restaurada con ${queue.size} mensaje(s) pendiente(s)`);
  }

  const checkpoint = new UpdateCheckpoint(
    join(process.cwd(), config.dataDir, "updates.json"),
  );
  await checkpoint.load();

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
  withCheckpoint(bot, checkpoint);

  const stop = () => {
    dispatcher.stop();
    void checkpoint.flush().finally(() => bot.stop());
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await startBot(bot, checkpoint);
}

main().catch((error) => {
  console.error("[gateway] Error fatal:", error);
  process.exit(1);
});