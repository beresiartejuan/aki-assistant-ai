import { Agent, type Dispatcher } from "undici";

/**
 * Dispatcher HTTP que fuerza IPv4 en todas las conexiones.
 *
 * Se usa tanto para la API de Telegram (desde grammY, vía baseFetchConfig)
 * como para las llamadas HTTP a agent-core, para evitar el bug de IPv6
 * de la red local del host.
 */
export const ip4Dispatcher: Dispatcher = new Agent({
  connect: {
    // Forzar IPv4: dns.lookup con family 4 y solo conexiones IPv4.
    family: 4,
    autoSelectFamily: false,
  },
});

/**
 * POST JSON a una URL usando el dispatcher IPv4.
 * Devuelve el código de estado y el body parseado como JSON (si es posible).
 */
export async function postJson(
  url: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const { origin, pathname } = new URL(url);
  const res = await ip4Dispatcher.request({
    origin,
    path: pathname,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  let parsed: unknown = null;
  try {
    parsed = await res.body.json();
  } catch {
    // Body no-JSON o vacío; no es un error en sí.
  }

  return { status: res.statusCode, body: parsed };
}