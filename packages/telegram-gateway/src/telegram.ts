import { Bot } from "grammy";
import { config } from "./config.js";
import { ip4Dispatcher } from "./http.js";
import type { PersistentQueue } from "./queue.js";
import type { Message } from "./types.js";

/**
 * Bot de Telegram con long polling.
 *
 * Toda la comunicación con api.telegram.org sale por un dispatcher
 * HTTP forzado a IPv4 (bug de red local con IPv6).
 */
export function createBot(queue: PersistentQueue): Bot {
  if (!config.botToken) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN no está definido; configúralo en el entorno o en .env",
    );
  }

  const bot = new Bot(config.botToken, {
    client: {
      baseFetchConfig: {
        // dispatcher undici → fuerza IPv4 hacia api.telegram.org
        dispatcher: ip4Dispatcher,
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