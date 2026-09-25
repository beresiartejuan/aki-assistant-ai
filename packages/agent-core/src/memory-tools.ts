/**
 * Tools de memoria del agente (capas 1-4).
 *
 * Política de autonomía por capa:
 * - capa 1 (scratchpad): libre, efímero, se reescribe entero
 * - capa 2 (episodios): insertar libre, sin UPDATE/DELETE (append-only)
 * - capa 3 (semántica): SOLO propone candidatos; la consolidación decide
 * - capa 4 (hechos): escritura versionada, nunca pisa sin rastro
 */
import { z } from "zod";
import { ToolError, type Tool } from "./tools.js";
import { memory } from "./memory.js";
import { readSandboxFile, writeSandboxFile } from "./sandbox-files.js";

/** Path del scratchpad dentro del workspace de la tarea. */
export const SCRATCHPAD_PATH = ".agent/scratchpad.md";

/** Tool: escribe el scratchpad de la tarea actual (capa 1, efímero). */
export const writeScratchpad: Tool<{ content: string }> = {
  name: "write_scratchpad",
  description:
    "Escribe tu bloc de notas de la tarea actual (plan, pasos hechos, hallazgos). " +
    "SE REESCRIBE ENTERO en cada llamada: enviá siempre la versión completa actualizada, " +
    "no un diff ni un apéndice. Es efímero: vive solo durante la tarea. Úsalo para no perder " +
    "el hilo en tareas largas (multisegmento) y mantener un plan al día.",
  schema: z.object({
    content: z.string().min(1).max(40000).describe("Contenido COMPLETO del scratchpad (markdown)"),
  }),
  run: async (args, ctx) => {
    await writeSandboxFile(ctx.taskId, SCRATCHPAD_PATH, args.content);
    return { written: SCRATCHPAD_PATH, bytes: Buffer.byteLength(args.content) };
  },
};

/** Tool: lee el scratchpad actual (capa 1). */
export const readScratchpad: Tool<Record<string, never>> = {
  name: "read_scratchpad",
  description:
    "Lee tu bloc de notas de la tarea actual. Útil al retomar el trabajo (multisegmento) " +
    "o cuando dudés qué pasos ya hiciste.",
  schema: z.object({}),
  run: async (_args, ctx) => {
    const res = await readSandboxFile(ctx.taskId, SCRATCHPAD_PATH);
    return res ?? { empty: true };
  },
};

/** Tool: agrega una observación al historial episódico (capa 2, append-only). */
export const logEpisode: Tool<{ text: string }> = {
  name: "log_episode",
  description:
    "Registra una observación importante en tu historial de largo plazo (append-only, " +
    "no se puede editar ni borrar). Ej: 'el executor rechaza timeouts > 120s', 'el usuario " +
    "prefiere respuestas cortas'. NO lo uses para datos triviales de la tarea: solo para " +
    "aprendizajes o hechos que te sirvan más adelante.",
  schema: z.object({
    text: z.string().min(1).max(2000).describe("Observación en una frase clara y autónoma"),
  }),
  run: async (args, ctx) => {
    if (!memory) throw new ToolError("Memoria no disponible");
    memory.appendEpisode(ctx.taskId, "observation", args.text, true);
    return { logged: true };
  },
};

/** Tool: lee los últimos episodios del historial (capa 2, solo lectura). */
export const recallEpisodes: Tool<{ limit?: number }> = {
  name: "recall_episodes",
  description:
    "Lee las últimas observaciones de tu historial (de tareas anteriores y de esta). " +
    "Solo lectura: el historial es append-only y no se puede modificar.",
  schema: z.object({
    limit: z.number().int().min(1).max(50).optional().describe("Cantidad (default 10)"),
  }),
  run: async (args) => {
    if (!memory) throw new ToolError("Memoria no disponible");
    const rows = memory.recentEpisodes(args.limit ?? 10);
    return { episodes: rows.map((r) => ({ ts: r.ts, text: r.text, ok: r.ok })) };
  },
};

/** Tool: propone un aprendizaje para la memoria semántica (capa 3). */
export const proposeMemory: Tool<{ text: string }> = {
  name: "propose_memory",
  description:
    "PROPONÉ un aprendizaje de largo plazo (no se guarda todavía): un proceso de " +
    "consolidación decidirá si entra en tu memoria semántica (con dedupe y TTL). " +
    "Ej: 'takumi-js (no takumi) es el paquete npm para renderizar imágenes', " +
    "'los scripts de Python del sandbox necesitan python3, no python'. " +
    "Redacto en una frase autónoma y reutilizable en el futuro.",
  schema: z.object({
    text: z.string().min(1).max(1000).describe("Aprendizaje en una frase autónoma"),
  }),
  run: async (args, ctx) => {
    if (!memory) throw new ToolError("Memoria no disponible");
    memory.addCandidate(ctx.taskId, args.text);
    return {
      proposed: true,
      note: "Será evaluado en la próxima consolidación (dedupe + TTL).",
    };
  },
};

/** Tool: lee un hecho del sistema (capa 4). */
export const getFact: Tool<{ key?: string }> = {
  name: "get_fact",
  description:
    "Lee hechos del sistema (estado del entorno: servicios, rutas, configuración). " +
    "Sin 'key' devuelve todos los hechos actuales.",
  schema: z.object({
    key: z.string().min(1).max(200).optional().describe("Clave del hecho (opcional)"),
  }),
  run: async (args) => {
    if (!memory) throw new ToolError("Memoria no disponible");
    const rows = memory.getFact(args.key);
    if (rows.length === 0) return { found: false };
    return { found: true, facts: rows };
  },
};

/** Tool: escribe un hecho del sistema (capa 4, versionado). */
export const setFact: Tool<{ key: string; value: string }> = {
  name: "set_fact",
  description:
    "Actualiza un hecho del sistema (estado del entorno). El valor anterior queda " +
    "versionado automáticamente (nunca se pisa sin rastro). Usá claves estables y " +
    "autoexplicativas, ej: 'ollama_local_url', 'sistema_usuario_uid'.",
  schema: z.object({
    key: z.string().min(1).max(200).describe("Clave estable del hecho (snake_case)"),
    value: z.string().min(1).max(2000).describe("Valor del hecho"),
  }),
  run: async (args) => {
    if (!memory) throw new ToolError("Memoria no disponible");
    if (!/^[a-z][a-z0-9_]*$/.test(args.key)) {
      throw new ToolError("Clave inválida: usar snake_case (ej: ollama_local_url)");
    }
    const res = memory.setFact(args.key, args.value);
    return {
      key: args.key,
      version: res.version,
      previousVersion: res.previousVersion,
      note: "El valor anterior quedó archivado en facts_history.",
    };
  },
};

/** Tools de memoria para registrar en el registry. */
export const memoryTools = [
  writeScratchpad,
  readScratchpad,
  logEpisode,
  recallEpisodes,
  proposeMemory,
  getFact,
  setFact,
] as const;