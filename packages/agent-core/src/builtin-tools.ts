import { z } from "zod";
import { ToolRegistry, ToolError } from "./tools.js";
import { runCommand } from "./tool-run-command.js";
import { shell } from "./tool-shell.js";
import { deliverFile } from "./tool-deliver-file.js";

/**
 * Tools integradas del agente.
 *
 * Para agregar una tool nueva: definirla acá (o en otro archivo) y
 * registrarla en buildDefaultTools(). El schema Zod se convierte solo
 * a JSON Schema para el modelo.
 */

/** Fecha y hora actual del sistema. */
const getCurrentTime = {
  name: "get_current_time",
  description:
    "Devuelve la fecha y hora actual del sistema en ISO 8601, junto con el día de la semana. Úsala cuando el usuario pregunte la hora, la fecha o hable de 'hoy'.",
  schema: z.object({}),
  run: async () => {
    const now = new Date();
    return {
      iso: now.toISOString(),
      weekday: new Intl.DateTimeFormat("es-AR", { weekday: "long" }).format(now),
    };
  },
} as const;

/** Duración de una tarea, en segundos, a partir de texto en lenguaje natural. */
const calculate = {
  name: "calculate",
  description:
    "Evalúa una expresión aritmética simple y devuelve el resultado. Acepta +, -, *, /, paréntesis y números decimales. No acepta otra cosa.",
  schema: z.object({
    expression: z.string().min(1).max(200).describe("Expresión aritmética, ej: (2+3)*4"),
  }),
  run: async (args: { expression: string }) => {
    // Solo se permite una expresión aritmética: dígitos, operadores y paréntesis.
    if (!/^[0-9+\-*/().,\s]+$/.test(args.expression)) {
      throw new ToolError("Expresión inválida: solo se permiten números y operadores aritméticos");
    }
    // Eval protegido: la expresión ya fue validada con el regex anterior.
    const fn = new Function(`"use strict"; return (${args.expression.replace(/,/g, ".")});`);
    const value = fn();
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ToolError("La expresión no produjo un número finito");
    }
    return { expression: args.expression, result: value };
  },
} as const;

/** Herramientas por defecto del agente. */
export function buildDefaultTools(): ToolRegistry {
  const registry = new ToolRegistry();
  registry
    .register(getCurrentTime)
    .register(calculate)
    .register(runCommand)
    .register(shell)
    .register(deliverFile);
  return registry;
}