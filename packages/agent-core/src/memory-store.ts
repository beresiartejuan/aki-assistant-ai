/**
 * Memoria episódica (capa 2) + hechos del sistema (capa 4).
 *
 * SQLite en `data/memory.db` (separada de logs.db, que es infra de
 * logging). Diseño según la política de autonomía:
 *
 * - `episodes`: append-only. El store NO expone UPDATE/DELETE: el
 *   historial de acciones es intocable por diseño, no por policy.
 * - `facts`: hechos versionados del entorno. Escribir nunca pisa: la
 *   versión previa va a `facts_history` antes de actualizar.
 *
 * Todas las escrituras del agente pasan por aquí; el agente no tiene
 * acceso directo a la BD.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Episode {
  id: number;
  ts: string;
  task_id: string;
  kind: string; // tool | observation | task_end
  text: string;
  ok: number | null;
}

export interface Fact {
  key: string;
  value: string;
  version: number;
  updated_at: string;
}

export class MemoryStore {
  private db: DatabaseSync | null = null;
  private readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? join(process.cwd(), "data", "memory.db");
  }

  /** Abre la BD y crea tablas si no existen. Idempotente. */
  init(): void {
    if (this.db) return;
    try {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS episodes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          task_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          text TEXT NOT NULL,
          ok INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_episodes_ts ON episodes (ts);

        CREATE TABLE IF NOT EXISTS facts (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          version INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS facts_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          version INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_facts_history_key ON facts_history (key);

        CREATE TABLE IF NOT EXISTS memory_candidates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          task_id TEXT NOT NULL,
          text TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
        );
      `);
    } catch (error) {
      console.error("[memory] No se pudo abrir memory.db:", error);
      this.db = null;
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // noop
    }
    this.db = null;
  }

  private ready(): DatabaseSync {
    if (!this.db) {
      this.init();
    }
    if (!this.db) throw new Error("memory.db no disponible");
    return this.db;
  }

  // ── Capa 2: episodios (append-only) ────────────────────────────────

  /** Inserta un episodio. Única forma de escribir en la tabla. */
  appendEpisode(taskId: string, kind: string, text: string, ok?: boolean): void {
    try {
      this.ready()
        .prepare(
          "INSERT INTO episodes (ts, task_id, kind, text, ok) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          new Date().toISOString(),
          taskId,
          kind,
          text.slice(0, 4000),
          ok === undefined ? null : ok ? 1 : 0,
        );
    } catch (error) {
      console.error("[memory] Fallo insertando episodio:", error);
    }
  }

  /** Últimos N episodios de tareas ANTERIORES a la actual (más nuevos primero). */
  recentEpisodes(limit: number, excludeTaskId?: string): Episode[] {
    try {
      const rows = this.ready()
        .prepare(
          `SELECT id, ts, task_id, kind, text, ok FROM episodes
           WHERE task_id != ?
           ORDER BY id DESC LIMIT ?`,
        )
        .all(excludeTaskId ?? "", limit) as unknown as Episode[];
      return rows ?? [];
    } catch {
      return [];
    }
  }

  // ── Capa 4: hechos versionados ─────────────────────────────────────

  /** Lee un hecho por clave (o todos, si no se pasa clave). */
  getFact(key?: string): Fact[] {
    try {
      const db = this.ready();
      const rows = key
        ? db.prepare("SELECT key, value, version, updated_at FROM facts WHERE key = ?").all(key)
        : db.prepare("SELECT key, value, version, updated_at FROM facts ORDER BY key").all();
      return (rows ?? []) as unknown as Fact[];
    } catch {
      return [];
    }
  }

  /**
   * Escribe un hecho con versionado: si existía una versión previa, se
   * archiva en facts_history antes de actualizar. Nunca pisa sin rastro.
   */
  setFact(key: string, value: string): { version: number; previousVersion: number | null } {
    const db = this.ready();
    const now = new Date().toISOString();
    const prev = db
      .prepare("SELECT version FROM facts WHERE key = ?")
      .get(key) as { version: number } | undefined;

    const version = (prev?.version ?? 0) + 1;
    if (prev) {
      const old = db
        .prepare("SELECT value, version, updated_at FROM facts WHERE key = ?")
        .get(key) as { value: string; version: number; updated_at: string };
      db.prepare(
        "INSERT INTO facts_history (key, value, version, updated_at) VALUES (?, ?, ?, ?)",
      ).run(key, old.value, old.version, old.updated_at);
    }
    db.prepare(
      `INSERT INTO facts (key, value, version, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value,
         version = excluded.version, updated_at = excluded.updated_at`,
    ).run(key, value.slice(0, 2000), version, now);
    return { version, previousVersion: prev?.version ?? null };
  }

  /** Historial de versiones de una clave (más reciente primero). */
  factHistory(key: string, limit = 10): Array<{ version: number; value: string; updated_at: string }> {
    try {
      const rows = this.ready()
        .prepare(
          `SELECT version, value, updated_at FROM facts_history
           WHERE key = ? ORDER BY version DESC LIMIT ?`,
        )
        .all(key, limit);
      return (rows ?? []) as Array<{ version: number; value: string; updated_at: string }>;
    } catch {
      return [];
    }
  }

  // ── Capa 3: candidatos de memoria semántica ────────────────────────

  /** Propuesta del agente: se guarda pendiente; la consolidación decide. */
  addCandidate(taskId: string, text: string): void {
    this.ready()
      .prepare("INSERT INTO memory_candidates (ts, task_id, text) VALUES (?, ?, ?)")
      .run(new Date().toISOString(), taskId, text.slice(0, 2000));
  }

  /** Candidatos pendientes de consolidar. */
  pendingCandidates(limit = 20): Array<{ id: number; task_id: string; text: string; ts: string }> {
    try {
      const rows = this.ready()
        .prepare(
          "SELECT id, task_id, text, ts FROM memory_candidates WHERE status = 'pending' ORDER BY id LIMIT ?",
        )
        .all(limit);
      return (rows ?? []) as Array<{ id: number; task_id: string; text: string; ts: string }>;
    } catch {
      return [];
    }
  }

  /** Marca candidatos como procesados por la consolidación. */
  resolveCandidates(ids: number[], status: string): void {
    if (ids.length === 0) return;
    const db = this.ready();
    const stmt = db.prepare("UPDATE memory_candidates SET status = ? WHERE id = ?");
    for (const id of ids) {
      try {
        stmt.run(status, id);
      } catch (error) {
        console.error("[memory] Fallo resolviendo candidato:", error);
      }
    }
  }
}