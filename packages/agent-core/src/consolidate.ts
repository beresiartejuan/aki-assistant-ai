/**
 * Consolidación de la capa semántica (memoria de long-term).
 *
 * Corre al inicio de cada tarea (best-effort, nunca bloquea):
 *
 * 1. Procesa candidatos propuestos por el agente (propose_memory):
 *    - dedupe/reconfirmación por similitud (upsertLearning)
 * 2. Aplica decay/TTL: aprendizajes sin reconfirmación en
 *    MEMORY_TTL_DAYS (default 30) se eliminan de LanceDB.
 *
 * El agente solo propone; la consolidación decide qué entra.
 */
import { logger } from "./logger.js";
import { memory } from "./memory.js";
import { decayLearnings, upsertLearning } from "./semantic.js";

/** Procesa candidatos pendientes y aplica decay. Best-effort, sin lanzar. */
export async function consolidateMemory(): Promise<void> {
  try {
    const candidates = memory.pendingCandidates(20);
    for (const cand of candidates) {
      try {
        const outcome = await upsertLearning(cand.text);
        logger.info("memory", "Candidato consolidado", { id: cand.id, outcome });
      } catch (error) {
        logger.warn("memory", "Candidato descartado por error", {
          id: cand.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    memory.resolveCandidates(
      candidates.map((c) => c.id),
      "consolidated",
    );

    await decayLearnings();
  } catch (error) {
    logger.warn("memory", "Consolidación falló (no bloquea la tarea)", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
