# aki-agent

Agente de inteligencia artificial autónomo asistente que corre en tu propia máquina: atiende por Telegram, razona con un LLM (Ollama Cloud), y ejecuta acciones reales (comandos, scripts, npm, pip) en un sandbox Docker aislado.

```
Telegram ←→ telegram-gateway ──POST /messages──> agent-core ──POST /exec──> executor
                    ▲                                  │                        │
                    └───────── POST /results ──────────┘          Docker (workspace: /workspace)
```

## Monorepo (pnpm workspaces)

| Paquete | Ruta | Descripción |
| --- | --- | --- |
| `@aki/telegram-gateway` | `packages/telegram-gateway` | Bot de Telegram (grammY), cola persistente, checkpoint de updates, entrega de resultados + artifacts |
| `@aki/agent-core` | `packages/agent-core` | Loop agéntico con Ollama Cloud, sistema de tools propio (sin SDKs), memoria en capas, consolidación de aprendizajes |
| `@aki/executor` | `packages/executor` | Sandbox de ejecución en Docker (denylist + límites de recursos), artifacts HTTP |
| `@aki/event-manager` | `packages/event-manager` | Reservado (paquete vacío) — planeado: `@aki/types`, contratos compartidos gateway ↔ agent-core (hoy duplicados a mano) |

## Características

- **Sistema de tools propio** (`packages/agent-core/src/tools.ts`): sin frameworks de agentes; tools declarativas con schema Zod serializada a JSON Schema para Ollama.
- **Loop agéntico con continuación automática** (`state.ts`): hasta `AGENT_MAX_TOOL_ROUNDS` por segmento (15), con segmentos de continuación (3); al agotar un segmento se notifica progreso y el agente retoma con un nudge + su scratchpad.
- **Memoria de largo plazo** con política de autonomía por capa:
  - **Capa 0** `constitution.md` — reglas base, inyectadas al system prompt; el agente no puede escribirla (arquitectura, no policy).
  - **Capa 1** scratchpad por tarea (`workspace/.agent/scratchpad.md`), efímero; reinyectado al continuar tras un corte.
  - **Capa 2** episodios en SQLite `memory.db` — append-only (el store no expone UPDATE/DELETE).
  - **Capa 3** aprendizajes en LanceDB + embeddings locales (Ollama **local**: default `qwen3-embedding:0.6b`, 1024 dims); el agente solo `propose_memory`; consolidación con dedupe por similitud coseno y TTL (30 días).
  - **Capa 4** hechos versionados: `facts` + `facts_history` (nunca pisa sin rastro).
- **Sandbox Docker endurecido**: rootfs read-only, `/tmp` tmpfs noexec/nosuid, sin capabilities extras, límite RAM/PIDs, usuario 1000, denylist de binarios + anti-traversal lógico + verificación realpath (anti-symlink-escape).
- **Gateway endurecido**: bind loopback, allowlist de usuarios (`ALLOWED_TELEGRAM_USER_IDS`), auth inter-servicios por shared secret (`INTERNAL_API_KEY`, header `x-internal-key`), descarte del backlog al arrancar (drain).
- **Cola persistente** de mensajes y checkpoint de `update_id` (no reprocesa tras reinicio).

## Requisitos

- Node.js >= 22.5 (usa `node:sqlite` nativo)
- pnpm >= 10
- Docker (para el sandbox del executor; hay modo `process` de desarrollo en host)
- **Ollama Cloud** (API key) para el LLM principal y **Ollama local** para embeddings

## Setup rápido

```bash
# 1. Dependencias
pnpm install

# 2. Variables de entorno (cada paquete lee su propio .env)
cp packages/agent-core/.env.example packages/agent-core/.env
cp packages/executor/.env.example packages/executor/.env
cp packages/telegram-gateway/.env.example packages/telegram-gateway/.env

# 3. Completar: OLLAMA_API_KEY en agent-core, TELEGRAM_BOT_TOKEN en gateway,
#    INTERNAL_API_KEY (mismo valor) en los tres.

# 4. Imagen del sandbox
docker build -f packages/executor/docker/sandbox.Dockerfile -t aki-sandbox:latest packages/executor/docker/

# 5. Arrancar (en este orden, cada uno en su terminal)
pnpm --filter @aki/executor dev
pnpm --filter @aki/agent-core dev
pnpm --filter @aki/telegram-gateway dev
```

## Config (env vars por paquete)

### packages/agent-core/.env

| Variable | Default | Descripción |
| --- | --- | --- |
| `OLLAMA_API_KEY` | (obligatoria) | API key de Ollama Cloud |
| `OLLAMA_BASE_URL` | `https://ollama.com` | Endpoint de la API de chat |
| `OLLAMA_MODEL` | `nemotron-3-nano:30b` | Modelo principal |
| `GATEWAY_URL` | `http://localhost:3200` | Gateway (para POST /results) |
| `EXECUTOR_URL` | `http://localhost:3100` | Executor (tools shell/run_command) |
| `AGENT_MAX_TOOL_ROUNDS` | `15` | Rondas por segmento del loop |
| `AGENT_MAX_SEGMENTS` | `3` | Segmentos de continuación |
| `OLLAMA_LOCAL_URL` | `http://127.0.0.1:11434` | Ollama local (embeddings) |
| `OLLAMA_EMBED_MODEL` | `qwen3-embedding:0.6b` | Modelo de embeddings |
| `OLLAMA_EMBED_DIM` | `1024` | Dimensión del modelo de embeddings |
| `MEMORY_TTL_DAYS` | `30` | TTL de aprendizajes |
| `MEMORY_EPISODES_IN_CONTEXT` | `8` | Episodios previos inyectados al prompt |
| `MEMORY_SEMANTIC_TOP_K` | `5` | Top-K semántico inyectado |
| `MEMORY_FACTS_IN_CONTEXT` | `30` | Máximo de hechos inyectados |
| `BIND_HOST` | `127.0.0.1` | Interfaz HTTP de bind |
| `INTERNAL_API_KEY` | (vacío) | Secret compartido inter-servicios |

### packages/executor/.env

| Variable | Default | Descripción |
| --- | --- | --- |
| `EXECUTOR_SANDBOX_MODE` | `docker` | `docker` o `process` (host, dev) |
| `EXECUTOR_DATA_DIR` | `data/sandbox` | Root de workspaces por tarea |
| `EXECUTOR_SANDBOX_IMAGE` | `aki-sandbox:latest` | Imagen del sandbox |
| `EXECUTOR_NETWORK_MODE` | `bridge` | Red del contenedor: `none`/`bridge`/`host` |
| `EXECUTOR_CONTAINER_MEMORY` | 2GB | RAM por contenedor |
| `EXECUTOR_MAX_TIMEOUT_MS` | 120000 | Timeout máximo por comando |
| `EXECUTOR_MAX_OUTPUT_CHARS` | 10000 | stdout+stderr devueltos |
| `BIND_HOST` | `127.0.0.1` | Interfaz HTTP de bind |
| `INTERNAL_API_KEY` | (vacío) | Secret compartido |

### packages/telegram-gateway/.env

| Variable | Default | Descripción |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | (obligatorio) | Token de @BotFather |
| `AGENT_CORE_URL` | `http://localhost:3000` | agent-core |
| `EXECUTOR_URL` | `http://localhost:3100` | Executor (descarga artifacts) |
| `GATEWAY_PORT` | `3200` | Puerto del results server |
| `GATEWAY_SKIP_BACKLOG` | `true` | Descarta mensajes acumulados al arrancar |
| `ALLOWED_TELEGRAM_USER_IDS` | (obligatorio en prod) | Ids Telegram permitidos (coma) |
| `BIND_HOST` / `INTERNAL_API_KEY` | — | Idem a los otros servicios |

## Seguridad — modelo de amenaza

- Los tres servicios HTTP **bindean a loopback** y se autentican entre sí por shared secret (`x-internal-key`, generable con `openssl rand -hex 32`); los `/status` quedan abiertos para health-checks.
- El executor valida con **denylist de binarios + anti-traversal léxico + realpath** (anti-symlink) y rechaza symlinks al escribir.
- En modo `docker`: rootfs read-only, `/tmp` tmpfs noexec/nosuid, sin capabilities (sin ICMP crudo), límites RAM/PIDs, uid no privilegiado. En modo `process` (dev, inseguro): sin intérpretes inline ni comandos con path.
- El bot tiene **allowlist de usuarios**; desconocidos se ignoran con log.
- Toda la memoria del agente (episodios, aprendizajes, hechos) vive **fuera del sandbox**, inaccesible al agente por diseño.

## Diagnóstico

- `packages/agent-core/data/logs.db` (SQLite): tablas `logs` y `tasks` (estado, tokens, rounds por tarea).
- `packages/agent-core/data/memory.db`: `episodes`, `facts`, `facts_history`, `memory_candidates`.
- Logs a stdout de cada servicio (`pnpm --filter @aki/<pkg> dev`).

## Tests

```bash
pnpm typecheck   # types de todo el monorepo
pnpm build
# CI: .github/workflows/ci.yml (typecheck + build en Node 24)
```

(Aún sin suite de tests automatizados; los flujos están verificados con pruebas manuales e2e documentadas en los commits.)

## Licencia

MIT — ver [LICENSE](LICENSE).