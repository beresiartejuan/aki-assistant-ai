import { z } from "zod";

/**
 * Sistema de tools propio, sin dependencias de frameworks de agentes.
 *
 * Tres piezas desacopladas:
 * - `Tool`: definición declarativa (nombre, descripción, schema Zod, run)
 * - `ToolRegistry`: catálogo de tools y serialización a formato Ollama
 * - `ToolExecutor`: validación + ejecución con resultados tipados
 */

/** Error estándar para fallos esperables de una tool. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** Formato de tool de la API de Ollama / OpenAI. */
export interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Una tool: schema de args (Zod) + implementación. */
export interface Tool<TArgs = unknown> {
  /** Nombre único en snake_case (ej: get_current_time). */
  name: string;
  /** Descripción para que el modelo decida cuándo usarla. */
  description: string;
  /** Schema Zod de los argumentos; se serializa a JSON Schema para el modelo. */
  schema: z.ZodType<TArgs>;
  /** Implementación. Puede lanzar ToolError para errores esperables. */
  run: (args: TArgs, ctx: ToolContext) => Promise<unknown>;
}

/**
 * Contexto de ejecución, para inyectar dependencias sin acoplamiento.
 * El executor lo arma y las tools lo reciben.
 */
export interface ToolContext {
  /** Mensaje original del usuario que desencadenó la tarea. */
  userText: string;
  /** Id de la tarea en curso. */
  taskId: string;
  /**
   * Registro de archivos marcados como entregables por la tool
   * deliver_file. Solo estos se envían al usuario al terminar.
   */
  deliverables?: {
    add(path: string): void;
    has(path: string): boolean;
  };
}

/** Registro de tools disponible para el modelo. */
export class ToolRegistry {
  private tools = new Map<string, Tool<never>>();

  /** Registra una tool. Falla si el nombre es inválido o está duplicado. */
  register(tool: Tool<any>): this {
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) {
      throw new ToolError(
        `Nombre de tool inválido: "${tool.name}" (usar snake_case)`,
      );
    }
    if (this.tools.has(tool.name)) {
      throw new ToolError(`Tool duplicado: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as unknown as Tool<never>);
    return this; // encadenable: registry.register(a).register(b)
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool<never> | undefined {
    return this.tools.get(name);
  }

  /** Lista de nombres registrados. */
  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Registra varias tools de una vez (encadenable). */
  registerAll(tools: Array<Tool<any>>): this {
    for (const t of tools) this.register(t);
    return this;
  }

  /** Serializa todas las tools al formato `tools` de la API de Ollama. */
  toOllamaTools(): OllamaTool[] {
    return [...this.tools.values()].map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: z.toJSONSchema(tool.schema, { target: "draft-7" }),
      },
    }));
  }
}

/** Resultado de ejecutar una tool. */
export interface ToolResult {
  /** Nombre de la tool ejecutada. */
  name: string;
  /** true si la ejecución fue exitosa. */
  ok: boolean;
  /** Resultado serializable (éxito). */
  result?: unknown;
  /** Mensaje de error (fallo). */
  error?: string;
  /** Duración de la ejecución en ms. */
  durationMs: number;
}

/** Ejecuta tools validando argumentos con el schema Zod. */
export class ToolExecutor {
  constructor(private readonly registry: ToolRegistry) {}

  /**
   * Ejecuta una tool por nombre.
   *
   * Los errores de validación/ejecución NO lanzan: se devuelven como
   * ToolResult con ok=false para que el modelo los lea y se corrija.
   */
  async execute(
    name: string,
    rawArgs: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const start = Date.now();
    const tool = this.registry.get(name);

    if (!tool) {
      return {
        name,
        ok: false,
        error: `Tool desconocido: ${name}`,
        durationMs: 0,
      };
    }

    // Validación de args contra el schema Zod de la tool.
    const parsed = tool.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return {
        name,
        ok: false,
        error: `Argumentos inválidos: ${JSON.stringify(parsed.error.issues)}`,
        durationMs: Date.now() - start,
      };
    }

    try {
      const result = await tool.run(parsed.data as never, ctx);
      return {
        name,
        ok: true,
        result,
        durationMs: Date.now() - start,
      };
    } catch (error) {
      return {
        name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - start,
      };
    }
  }
}