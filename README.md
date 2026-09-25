# aki-agent

Agente de inteligencia artificial autónomo que funciona como asistente.

## Estructura del monorepo

| Paquete | Ruta | Descripción |
| --- | --- | --- |
| `@aki/telegram-gateway` | `packages/telegram-gateway` | Gateway de Telegram: puerta de entrada del agente, recibe y envía mensajes |
| `@aki/event-manager` | `packages/event-manager` | Gestor de eventos: enruta mensajes entre los componentes del agente |
| `@aki/agent-core` | `packages/agent-core` | Núcleo del agente: razonamiento, decisiones y orquestación |
| `@aki/executor` | `packages/executor` | Ejecutor: ejecuta las acciones decididas por el núcleo |

## Requisitos

- Node.js >= 22
- pnpm >= 10

## Comandos

```bash
# Instalar dependencias de todos los paquetes
pnpm install

# Compilar todos los paquetes
pnpm build

# Verificar tipos
pnpm typecheck

# Ejecutar tests
pnpm test

# Limpiar artefactos de build
pnpm clean
```

También puedes ejecutar cualquier comando en un paquete específico:

```bash
pnpm --filter @aki/agent-core build
```