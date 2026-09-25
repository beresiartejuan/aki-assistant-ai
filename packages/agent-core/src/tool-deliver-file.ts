import { z } from "zod";
import { ToolError, type Tool } from "./tools.js";

/**
 * Tool deliver_file: el agente marca explícitamente qué archivos del
 * workspace son entregables para el usuario.
 *
 * Sin esta tool, agent-core mandaba TODOS los archivos generados
 * (incluyendo trabajo interno: scrapes, datos, scripts). Con ella, el
 * modelo decide qué quiere que el usuario reciba por Telegram.
 *
 * La validación de que el archivo existe la hace el executor en el
 * momento del envío; acá solo registramos la intención.
 */

/** Tool que marca archivos como entregables. */
export const deliverFile: Tool<{ path: string; description?: string }> = {
  name: "deliver_file",
  description:
    "Entrega un archivo del workspace al usuario por el canal de chat (ej: Telegram). " +
    "Llamá esta tool UNA VEZ por archivo que quieras que el usuario reciba, recién cuando " +
    "esté listo (generado y verificado). Los archivos de trabajo interno (datos descargados, " +
    "scripts auxiliares, resultados intermedios) NO deben entregarse: solo el producto final " +
    "que el usuario pidió. Ejemplo: si generaste informe.html para que el usuario lo vea, " +
    "llamá deliver_file con path='informe.html'.",
  schema: z.object({
    /** Path relativo al workspace. */
    path: z.string().min(1).max(500).describe("Path relativo del archivo dentro del workspace, ej: informe.html"),
    /** Descripción corta opcional para el usuario. */
    description: z.string().max(200).optional(),
  }),
  run: async (args, ctx) => {
    if (!ctx.deliverables) {
      throw new ToolError("No hay registro de entregables en esta ejecución");
    }
    const clean = args.path.replace(/^\//, "").replace(/\\/g, "/");
    if (!clean || clean.startsWith("..") || clean.includes("../")) {
      throw new ToolError(`Path inválido: ${args.path}`);
    }
    if (ctx.deliverables.has(clean)) {
      return { path: clean, alreadyMarked: true };
    }
    ctx.deliverables.add(clean);
    return {
      path: clean,
      description: args.description,
      marked: true,
    };
  },
};