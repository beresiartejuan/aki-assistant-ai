import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
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

/** URL base de la Bot API de Telegram. */
const telegramApiUrl = `https://api.telegram.org/bot${config.botToken}`;

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

/**
 * Checkpoint del último update_id procesado.
 *
 * Sin esto, cada reinicio del gateway reprocesa los mensajes viejos
 * que Telegram todavía tiene en su cola. El checkpoint se persiste a
 * disco y se pasa como `offset` a getUpdates (Telegram descarta los
 * updates anteriores a offset una vez confirmados).
 */
export class UpdateCheckpoint {
  private lastUpdateId = 0;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly filePath: string) {}

  /** Carga el último update_id persistido. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.lastUpdateId = Number(JSON.parse(raw).lastUpdateId) || 0;
    } catch {
      this.lastUpdateId = 0; // primera ejecución
    }
    if (this.lastUpdateId > 0) {
      console.log(`[gateway] Checkpoint de updates: continuando desde ${this.lastUpdateId}`);
    }
  }

  /** Registra el update procesado y persiste el checkpoint (debounced). */
  mark(updateId: number): void {
    if (updateId <= this.lastUpdateId) return;
    this.lastUpdateId = updateId;
    // Debounce: Telegram repite update_id, no hace falta flush por update.
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), 2000);
    this.flushTimer.unref();
  }

  /** El valor a mandar como offset a getUpdates (último + 1), o undefined. */
  get offset(): number | undefined {
    return this.lastUpdateId > 0 ? this.lastUpdateId + 1 : undefined;
  }

  /** Persistencia atómica inmediata. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const tmp = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(tmp, JSON.stringify({ lastUpdateId: this.lastUpdateId }), "utf8");
    await rename(tmp, this.filePath);
  }
}

/**
 * Drena el backlog de updates pendientes al arrancar.
 *
 * Cuando el gateway estuvo apagado, Telegram acumula mensajes (ej:
 * pruebas del usuario). Se piden con getUpdates(timeout=0) en loop,
 * se marca el último update_id en el checkpoint (Telegram confirma y
 * descarta esos updates) y no se encolan: el bot arranca desde el
 * último mensaje como si ya hubiera sido leído/respondido.
 */
export async function drainBacklog(checkpoint: UpdateCheckpoint): Promise<number> {
  let drained = 0;
  for (;;) {
    const res = await fetchIp4(`${telegramApiUrl}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        offset: checkpoint.offset,
        timeout: 0,
        limit: 100,
      }),
    });
    const body = (await res.json()) as {
      ok: boolean;
      result?: Array<{ update_id: number }>;
      description?: string;
    };
    if (!body.ok || !body.result) {
      throw new Error(`getUpdates falló: ${body.description ?? res.status}`);
    }
    if (body.result.length === 0) break;
    for (const u of body.result) checkpoint.mark(u.update_id);
    drained += body.result.length;
    // Con offset confirmado, la siguiente llamada trae solo lo nuevo.
    if (body.result.length < 100) break;
  }
  await checkpoint.flush();
  if (drained > 0) {
    console.log(`[gateway] Backlog descartado: ${drained} update(s) viejos marcados como leídos`);
  }
  return drained;
}

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
      fetch: fetchIp4 as never,
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

/**
 * Arranca el polling con parada graceful en SIGINT/SIGTERM.
 *
 * Inyecta el último update_id procesado en el campo interno de grammY
 * (lastTriedUpdateId) para que el primer getUpdates use
 * offset = último+1 y Telegram no re-envíe mensajes ya procesados.
 */
export async function startBot(bot: Bot, checkpoint?: UpdateCheckpoint): Promise<void> {
  process.once("SIGINT", () => bot.stop());
  process.once("SIGTERM", () => bot.stop());

  if (checkpoint && checkpoint.offset !== undefined) {
    // Campo interno de grammY (privado en types, estable en runtime):
    // con esto el primer getUpdates parte de offset = último+1.
    (bot as unknown as { lastTriedUpdateId: number }).lastTriedUpdateId =
      checkpoint.offset - 1;
  }

  await bot.start({
    onStart: (me) => console.log(`[gateway] Bot conectado como @${me.username}`),
  });
}

/**
 * Envuelve el handler de updates del bot para marcar el checkpoint
 * después de cada update procesado (con éxito o con error manejado).
 */
export function withCheckpoint(bot: Bot, checkpoint: UpdateCheckpoint): void {
  bot.use(async (ctx, next) => {
    await next();
    // grammY procesa secuencialmente; al salir del middleware el
    // update ya fue manejado (enqueued o ignorado por bot.catch).
    checkpoint.mark(ctx.update.update_id);
  });
}