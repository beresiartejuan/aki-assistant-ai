/**
 * Singleton de memoria del proceso.
 *
 * - `memory` (SQLite): capas 2 y 4 + candidatos (capa 3).
 * - LanceDB (capa 3) se accede por módulo (semantic.ts).
 * - `constitution.md` (capa 0): archivo estático, solo lectura.
 */
import { MemoryStore } from "./memory-store.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Store SQLite de episodios + hechos + candidatos. */
export const memory = new MemoryStore();

/** Lee la constitución (capa 0). Cachea el contenido una vez leído. */
let constitutionCache: string | null = null;

/** Texto de la constitución ("" si no existe el archivo). */
export function getConstitution(): string {
  if (constitutionCache !== null) return constitutionCache;
  try {
    const path = join(process.cwd(), "constitution.md");
    if (existsSync(path)) {
      constitutionCache = readFileSync(path, "utf8");
    } else {
      constitutionCache = "";
    }
  } catch {
    constitutionCache = "";
  }
  return constitutionCache;
}
