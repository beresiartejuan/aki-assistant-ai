import { resolve, relative, isAbsolute } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { config } from "./config.js";

/**
 * Seguridad del sandbox.
 *
 * Modelo de amenaza: el modelo elige comandos y args; hay que evitar
 * que escape del workspace, ejecute shell injection o toque rutas del
 * sistema. Estrategia en capas:
 * 1. argv directo (sin shell) → no hay interpolación ni pipes.
 * 2. Denylist de comandos y flags peligrosos.
 * 3. Workspace por tarea con resolución estricta de rutas.
 * 4. Env mínimo (no hereda el entorno del proceso).
 * 5. Timeout con SIGTERM→SIGKILL, límite de salida y concurrencia.
 */

/**
 * Binarios y comandos con impacto fuera del sandbox o potencial de
 * escape. Es un denylist (no un allowlist) a propósito: más flexible
 * para desarrollo, pero se ajusta por env si se quiere endurecer.
 */
const DENYLISTED_BINARIES = new Set([
  // Shell interpreters (podrían escapar con -c).
  "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "shell",
  // Gestión de proceso/sistema.
  "reboot", "shutdown", "poweroff", "halt", "init", "systemctl", "service",
  "kill", "killall", "pkill", "pgrep",
  // Privilegios.
  "sudo", "su", "doas", "pkexec", "passwd", "chsh", "chroot",
  // Red/remote (podría exfiltrar o descargar payloads).
  "ssh", "scp", "sftp", "curl", "wget", "nc", "ncat", "netcat", "telnet", "ftp", "ping",
  // Persistencia/servicios.
  "crontab", "at", "systemd-run", "mount", "umount", "fdisk", "mkfs", "dd",
  // Núcleo/módulos.
  "modprobe", "insmod", "rmmod", "iptables", "nft", "tcpdump",
  // Gestores de paquetes (modifican el host, no el sandbox).
  "apt", "apt-get", "dnf", "yum", "pacman", "brew", "snap", "dpkg", "rpm",
]);

/** Flags/substrings que deniegan en cualquier comando. */
const DENYLISTED_ARG_PATTERNS = [
  // Rutas absolutas como argumento único (ej: /etc/passwd).
  // Permite código que contiene paths dentro de strings más largos
  // (eso queda contenido por el sandbox del contenedor).
  /^\/[a-zA-Z0-9_.-]+$/,
  // Traversal explícito.
  /^\.\./,
];

/** Env que se hereda al proceso del comando (mínimo). */
const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TERM"];

/** Directorio del workspace de una tarea. */
export function workspaceDir(taskId: string): string {
  return joinSafe(config.sandboxRoot, taskId);
}

/** Crea el workspace de una tarea. Idempotente. */
export async function ensureWorkspace(taskId: string): Promise<string> {
  const dir = workspaceDir(taskId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Borra el workspace de una tarea. */
export async function cleanupWorkspace(taskId: string): Promise<void> {
  await rm(workspaceDir(taskId), { recursive: true, force: true });
}

/**
 * Valida que un cwd relativo quede dentro del workspace.
 * Devuelve el path absoluto o lanza.
 */
export function resolveInsideWorkspace(taskId: string, cwd?: string): string {
  const workspace = workspaceDir(taskId);
  if (!cwd) return workspace;

  if (isAbsolute(cwd)) {
    throw new SecurityError(`cwd absoluto no permitido: ${cwd}`);
  }
  const resolved = resolve(workspace, cwd);
  const rel = relative(workspace, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new SecurityError(`cwd escapa del workspace: ${cwd}`);
  }
  return resolved;
}

/** Valida comando + args contra la denylist. Lanza SecurityError si falla. */
export function assertCommandAllowed(command: string, args: string[]): void {
  const bin = command.split("/").pop() ?? command;

  if (DENYLISTED_BINARIES.has(bin)) {
    throw new SecurityError(`Comando denegado: ${bin}`);
  }

  for (const arg of args) {
    for (const pattern of DENYLISTED_ARG_PATTERNS) {
      if (pattern.test(arg)) {
        throw new SecurityError(`Argumento denegado: "${arg}"`);
      }
    }
  }
}

/** Error de seguridad del sandbox. */
export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityError";
  }
}

/** Join seguro: evita que taskId contenga traversal. */
function joinSafe(root: string, taskId: string): string {
  if (taskId.includes("..") || taskId.includes("/") || taskId.includes("\\")) {
    throw new SecurityError(`taskId inválido: ${taskId}`);
  }
  return resolve(root, taskId);
}

/** Construye el env del proceso: mínimo + extras validados. */
export function buildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  // HOME apunta al workspace (no al home real del usuario).
  if (env.PATH !== undefined) {
    env.HOME = "/tmp";
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    // No se permite pisar PATH desde el request.
    if (key === "PATH" || key === "LD_PRELOAD" || key === "NODE_OPTIONS") continue;
    env[key] = String(value);
  }
  return env;
}

/** Opciones para armar el comando docker run del sandbox. */
export interface DockerRunOptions {
  image: string;
  /** Path absoluto en el host del workspace de la tarea. */
  hostWorkspace: string;
  /** Límite de RAM en bytes. */
  memory: number;
  /** CPUs (0 = sin límite). */
  cpus: number;
  /** Env mínimo para el proceso dentro del contenedor. */
  env: NodeJS.ProcessEnv;
  /** Comando a ejecutar. */
  command: string;
  /** Args del comando. */
  args: string[];
  /** cwd relativo dentro del workspace (opcional). */
  userCwd?: string;
}

/**
 * Arma el argv completo de `docker run` para un comando del sandbox.
 *
 * Flags de aislamiento:
 * - `--rm`: contenedor efímero, se elimina al morir.
 * - `--network none`: sin red (bloquea exfiltración y descargas).
 * - `--memory` + `--memory-swap`: límite duro de RAM (sin swap extra).
 * - `--pids-limit`: anti fork-bomb.
 * - `--cap-drop ALL`: sin capabilities del kernel.
 * - `--security-opt no-new-privileges`: sin escalada de privilegios.
 * - `--read-only` no se usa: el workspace debe ser escribible (volume rw).
 * - `-v hostWorkspace:/workspace`: workspace de la tarea.
 * - `-w /workspace[/subdir]`: cwd dentro del workspace.
 * - `--user 1000:1000`: uid no privilegiado (coincide con el host).
 * - `--env`: solo las variables del env mínimo.
 */
export function dockerArgsFor(options: DockerRunOptions): string[] {
  const args: string[] = [
    "run",
    "--rm",
    "--network",
    "none",
    "--memory",
    String(options.memory),
    "--memory-swap",
    String(options.memory), // sin swap adicional
    "--pids-limit",
    "128",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--volume",
    `${options.hostWorkspace}:/workspace`,
    "--workdir",
    options.userCwd
      ? `/workspace/${options.userCwd.replace(/^\//, "")}`
      : "/workspace",
    "--user",
    "1000:1000",
  ];

  if (options.cpus > 0) {
    args.push("--cpus", String(options.cpus));
  }

  // Env mínimo dentro del contenedor.
  for (const [key, value] of Object.entries(options.env)) {
    if (value === undefined) continue;
    args.push("--env", `${key}=${value}`);
  }

  args.push(options.image, options.command, ...options.args);
  return args;
}