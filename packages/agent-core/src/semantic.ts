/**
 * Memoria semántica (capa 3) en LanceDB.
 *
 * Tabla `learnings`: aprendizajes de largo plazo entre sesiones.
 * - `vector` fijo de EMBED_DIM dims con embeddings locales (embed.ts).
 * - `weight` crece en cada reconfirmación (dedupe por similitud).
 * - `last_confirmed_at` alimenta el decay/TTL: si un aprendizaje no se
 *   reconfirma dentro del TTL, la consolidación lo elimina.
 *
 * El agente NUNCA escribe acá directo: solo propone candidatos
 * (memory-store.ts) y un proceso de consolidación aparte decide.
 */
import * as lancedb from "@lancedb/lancedb";
import { join } from "node:path";
import { config } from "./config.js";
import { embed, EMBED_DIM } from "./embed.js";

export interface Learning {
  id: string;
  text: string;
  vector: number[];
  weight: number;
  created_at: string;
  last_confirmed_at: string;
}

/** Ruta de la base LanceDB (cwd del paquete). */
export function semanticDbPath(): string {
  return join(process.cwd(), "data", "memory-lancedb");
}

/** Abre/crea la tabla `learnings`, garantizando el esquema con vectores. */
async function openTable(): Promise<lancedb.Table> {
  const db = await lancedb.connect(semanticDbPath());
  const names = await db.tableNames();
  if (!names.includes("learnings")) {
    // Tabla vacía: LanceDB infiere el esquema de la primera fila, así
    // que creamos con una fila "seed" (vector cero, id imposible) y la
    // borramos: queda el esquema con vector de tamaño fijo.
    const zero = new Array(EMBED_DIM).fill(0);
    const table = await db.createTable("learnings", [
      {
        id: "__seed__",
        text: "",
        vector: zero,
        weight: 0,
        created_at: "",
        last_confirmed_at: "",
      },
    ]);
    await table.delete("id = '__seed__'");
    return table;
  }
  return await db.openTable("learnings");
}

/** Escapa comillas simples para predicados SQL de LanceDB. */
function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Inserta o reconfirma un aprendizaje:
 * - Si existe uno suficientemente parecido (sim >= threshold), suma
 *   weight y actualiza last_confirmed_at (reconfirmación).
 * - Sino, inserta uno nuevo con weight=1.
 */
export async function upsertLearning(
  text: string,
  threshold = 0.9,
): Promise<"inserted" | "reconfirmed"> {
  const vector = await embed(text);
  const table = await openTable();
  const now = new Date().toISOString();

  const near = (await table.vectorSearch(vector).distanceType("cosine").limit(1).toArray()) as Array<{
    id: string;
    text: string;
    weight: number;
    _distance: number;
  }>;
  const best = near[0];

  if (best && best.id !== "__seed__" && best.text) {
    const sim = 1 - best._distance; // coseno: distancia 0 = idéntico
    if (sim >= 0.98) {
      // Casi idéntico: refresca el texto sin inflar el peso.
      await table.update({
        where: `id = '${sqlEscape(best.id)}'`,
        values: { text },
      });
      return "reconfirmed";
    }
    if (sim >= threshold) {
      await table.update({
        where: `id = '${sqlEscape(best.id)}'`,
        values: {
          weight: (best.weight ?? 1) + 1,
          last_confirmed_at: now,
          text,
        },
      });
      return "reconfirmed";
    }
  }

  await table.add([
    {
      id: crypto.randomUUID(),
      text,
      vector,
      weight: 1,
      created_at: now,
      last_confirmed_at: now,
    },
  ]);
  return "inserted";
}

/**
 * Decay/TTL de la capa semántica: elimina aprendizajes sin
 * reconfirmación dentro del TTL (config.memoryTtlDays, default 30).
 */
export async function decayLearnings(): Promise<void> {
  const table = await openTable();
  const cutoff = new Date(
    Date.now() - config.memoryTtlDays * 24 * 3600 * 1000,
  ).toISOString();
  // ISO-8601 se compara lexicográficamente: válido en el SQL de LanceDB.
  await table.delete(`last_confirmed_at < '${cutoff}'`);
}

/** Búsqueda semántica: top-K aprendizajes más relevantes para una query. */
export async function searchLearnings(
  query: string,
  k = 5,
): Promise<Array<{ text: string; weight: number; score: number }>> {
  const table = await openTable();
  const vector = await embed(query);
  const rows = (await table.vectorSearch(vector).distanceType("cosine").limit(k).toArray()) as Array<{
    id: string;
    text: string;
    weight: number;
    _distance: number;
  }>;
  return rows
    .filter((r) => r.text && r.id !== "__seed__")
    .map((r) => ({ text: r.text, weight: r.weight, score: 1 - r._distance }));
}

/** Cantidad de aprendizajes almacenados. */
export async function countLearnings(): Promise<number> {
  const table = await openTable();
  return await table.countRows();
}