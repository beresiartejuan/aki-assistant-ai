/**
 * Sistema de logs en SQLite, aislado del resto del código.
 *
 * Usa `node:sqlite` (integrado en Node >= 22.5, estable en 24) para no
 * sumar dependencias. Persiste en `data/logs.db` con:
 * - tabla `logs`: eventos generales (INFO/WARN/ERROR)
 * - tabla `tasks`: una fila por tarea del agente, con resultado y timings
 *
 * El resto del código solo importa `logger` y llama a sus métodos.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LoggerOptions {
  /** Ruta del archivo SQLite. Default: data/logs.db */
  dbPath?: string;
}

/**
 * Módulo de logging en SQLite.
 *
 * - Escrituras sincronas y pequeñas (log por línea): ok para SQLite.
 * - Nunca lanza: si la BD falla, degrada a console y sigue.
 */
export class Logger {
  private db: DatabaseSync | null = null;
  private readonly dbPath: string;

  constructor(options: LoggerOptions = {}) {
    this.dbPath = options.dbPath ?? join(process.cwd(), "data", "logs.db");
  }

  /** Abre la BD y crea tablas si no existen. Idempotente. */
  init(): void {
    if (this.db !== null) return;
    try {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          level TEXT NOT NULL,
          component TEXT NOT NULL,
          message TEXT NOT NULL,
          meta TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts);
        CREATE INDEX IF NOT EXISTS idx_logs_level ON logs (level);

        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          status TEXT NOT NULL DEFAULT 'running',
          chat_id TEXT,
          user_text TEXT,
          model TEXT,
          reply_text TEXT,
          prompt_tokens INTEGER,
          eval_tokens INTEGER,
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_started ON tasks (started_at);
      `);
    } catch (error) {
      console.error("[logger] No se pudo abrir la BD de logs:", error);
      this.db = null; // degradar a console
    }
  }

  /** Cierra la BD. */
  close(): void {
    try {
      this.db?.close();
    } catch {
      // noop
    }
    this.db = null;
  }

  /** Log genérico. `meta` se serializa a JSON si se pasa. */
  log(level: LogLevel, component: string, message: string, meta?: unknown): void {
    const ts = new Date().toISOString();
    console[level === "debug" ? "log" : level](`[${component}] ${message}`);
    if (this.db === null) return;
    try {
      this.db
        .prepare(
          "INSERT INTO logs (ts, level, component, message, meta) VALUES (?, ?, ?, ?, ?)",
        )
        .run(ts, level, component, message, meta === undefined ? null : JSON.stringify(meta));
    } catch (error) {
      console.error("[logger] Fallo insertando log:", error);
    }
  }

  debug(component: string, message: string, meta?: unknown): void {
    this.log("debug", component, message, meta);
  }

  info(component: string, message: string, meta?: unknown): void {
    this.log("info", component, message, meta);
  }

  warn(component: string, message: string, meta?: unknown): void {
    this.log("warn", component, message, meta);
  }

  error(component: string, message: string, meta?: unknown): void {
    this.log("error", component, message, meta);
  }

  /** Registra el inicio de una tarea. */
  taskStart(taskId: string, chatId: string, userText: string): void {
    try {
      this.db
        ?.prepare(
          "INSERT INTO tasks (id, started_at, status, chat_id, user_text) VALUES (?, ?, 'running', ?, ?)",
        )
        .run(taskId, new Date().toISOString(), chatId, userText);
    } catch (error) {
      console.error("[logger] Fallo registrando inicio de tarea:", error);
    }
  }

  /** Marca una tarea como completada. */
  taskDone(
    taskId: string,
    result: {
      model: string;
      replyText: string;
      promptTokens?: number;
      evalTokens?: number;
    },
  ): void {
    try {
      this.db
        ?.prepare(
          `UPDATE tasks
           SET status = 'done', finished_at = ?, model = ?, reply_text = ?,
               prompt_tokens = ?, eval_tokens = ?
           WHERE id = ?`,
        )
        .run(
          new Date().toISOString(),
          result.model,
          result.replyText,
          result.promptTokens ?? null,
          result.evalTokens ?? null,
          taskId,
        );
    } catch (error) {
      console.error("[logger] Fallo marcando tarea como hecha:", error);
    }
  }

  /** Marca una tarea como fallida. */
  taskFail(taskId: string, errorMessage: string): void {
    try {
      this.db
        ?.prepare(
          "UPDATE tasks SET status = 'failed', finished_at = ?, error = ? WHERE id = ?",
        )
        .run(new Date().toISOString(), errorMessage, taskId);
    } catch (error) {
      console.error("[logger] Fallo marcando tarea como fallida:", error);
    }
  }

  /** Últimos N logs (para diagnóstico). */
  recentLogs(limit = 50): Array<{
    id: number;
    ts: string;
    level: string;
    component: string;
    message: string;
    meta: string | null;
  }> {
    try {
      const rows = this.db
        ?.prepare(
          "SELECT id, ts, level, component, message, meta FROM logs ORDER BY id DESC LIMIT ?",
        )
        .all(limit) as Array<{
        id: number;
        ts: string;
        level: string;
        component: string;
        message: string;
        meta: string | null;
      }>;
      return rows ?? [];
    } catch {
      return [];
    }
  }
}

/** Instancia única del logger del proceso. */
export const logger = new Logger();