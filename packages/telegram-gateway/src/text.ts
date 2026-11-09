/** Límite de caracteres de un mensaje de texto de Telegram. */
export const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Divide un texto en trozos de a lo sumo `max` caracteres, prefiriendo
 * cortar en salto de línea o espacio. No devuelve trozos vacíos.
 */
export function splitMessage(text: string, max = TELEGRAM_MAX_LENGTH): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    // Evita partir un par surrogate.
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^[\n ]/, "");
  }
  if (rest.trim().length > 0) chunks.push(rest);
  return chunks;
}
