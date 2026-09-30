/**
 * Auth inter-servicios por shared secret.
 *
 * El mismo valor de INTERNAL_API_KEY debe estar en el .env de los tres
 * servicios. Los servidores HTTP lo exigen en endpoints sensibles; los
 * clientes internos lo mandan en cada request inter-servicio.
 *
 * NOTA: los config.ts de cada paquete ya cargan el .env con
 * process.loadEnvFile() al importarse, así que acá solo leemos
 * process.env. Si INTERNAL_API_KEY está vacío, NO se exige (modo dev).
 */
import type { Context, Next } from "hono";

/** Header donde viaja el secret. */
export const AUTH_HEADER = "x-internal-key";

/** Valor del secret configurado ("" = auth deshabilitada, desarrollo). */
export function internalApiKey(): string {
  return process.env.INTERNAL_API_KEY ?? "";
}

/** Middleware Hono: exige el secret si INTERNAL_API_KEY está configurado. */
export function requireInternalKey() {
  return async (c: Context, next: Next) => {
    const expected = internalApiKey();
    if (expected && c.req.header(AUTH_HEADER) !== expected) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}

/** Headers de auth para clientes inter-servicio (vacíos si no hay secret). */
export function internalAuthHeaders(): Record<string, string> {
  const key = internalApiKey();
  return key ? { [AUTH_HEADER]: key } : {};
}