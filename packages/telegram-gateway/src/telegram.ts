import { Bot } from "grammy";
import { config } from "./config.js";
import type { PersistentQueue } from "./queue.js";
import type { Message } from "./types.js";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * Bot de Telegram con long polling.
 *
 * Dos problemas de entorno que este módulo resuelve:
 * 1. El fetch global de Node intenta IPv6 primero y se cuelga en esta
 *    red → todo va por undici.fetch con un Agent forzado a IPv4.
 * 2. grammY usa el AbortController del paquete "abort-controller"
 *    (shim), cuyo signal no es instancia del AbortSignal nativo que
 *    undici exige → se puentea a un signal nativo en el wrapper.
 */

/** Agente undici que fuerza IPv4. */
const ip4Agent = new Agent({
  connect: { family: 4, autoSelectFamily: false },
});

/** fetch (Web API) con IPv4 forzado y signal nativo. */
const fetchIp4 = async (input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) => {
  let nativeSignal: AbortSignal | undefined;
  if (init?.signal) {
    const controller = new AbortController();
    init.signal.addEventListener("abort", () => controller.abort());
    if (init.signal.aborted) controller.abort();
    nativeSignal = controller.signal;
  }
  return undiciFetch(input, { ...(init ?? {}), dispatcher: ip4Agent, signal: nativeSignal });
};

export function createBot(queue: PersistentQueue): Bot {
  if (!config.botToken) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN no está definido; configúralo en el entorno o en .env",
    );
  }

  const bot = new Bot(config.botToken, {
    client: {
      // El fetch custom va al nivel del client (no dentro de baseFetchConfig):
      // grammY usa node-fetch por defecto, que no respeta los dispatchers
      // del fetch global de Node.
      fetch: fetchIp4 as unknown as (url: string, init?: Record<string, unknown>) => Promise<Response>,
      baseFetchConfig: {
        compress: true,
      },
    },
  });

  /** Convierte un mensaje de Telegram en el mensaje del agente. */
  function toAgentMessage(ctx: { msg?: { chat: { id: number }; from?: { username?: string; id: number }; text?: string } }): Message | null {
    const msg = ctx.msg;
    if (!msg?.text) return null;
    return {
      chatId: String(msg.chat.id),
      text: msg.text,
      from: msg.from?.username ?? String(msg.from?.id ?? "unknown"),
      receivedAt: new Date().toISOString(),
    };
  }

  /** Encola el mensaje para que lo despache el Dispatcher. */
  async function enqueue(ctx: { msg?: unknown }): Promise<void> {
    const message = toAgentMessage(ctx as never);
    if (message === null) {
      console.log("[gateway] Update sin texto; ignorado");
      return;
    }
    await queue.enqueue(message);
    console.log(`[gateway] Mensaje encolado de chat ${message.chatId}`);
  }

  bot.on("message:text", (ctx) => enqueue(ctx));

  bot.catch((err) => {
    console.error(`[gateway] Error procesando update ${err.ctx.update?.update_id}:`, err.error);
  });

  return bot;
}

/** Arranca el polling con parada graceful en SIGINT/SIGTERM. */
export async function startBot(bot: Bot): Promise<void> {
  process.once("SIGINT", () => bot.stop());
  process.once("SIGTERM", () => bot.stop());
  await bot.start({
    onStart: (me) => console.log(`[gateway] Bot conectado como @${me.username}`),
  });
}