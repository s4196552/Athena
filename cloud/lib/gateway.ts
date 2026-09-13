import 'server-only';
import { formatNumber } from './format';

/* The demo gateway's health endpoint is unauthenticated and reports capacity,
 * never content -- so the landing page can show whether the model-backed half
 * of the demo is live right now.
 *
 * The static page this replaces called the gateway from the browser, which is
 * the only reason its CSP needed `connect-src *`. Doing it here instead means
 * the browser never makes a cross-origin request, there is no CORS dependency,
 * and the Railway URL is an environment variable rather than a constant
 * hand-edited into a shipped file.
 */

export type GatewayStatus = {
  state: 'up' | 'down' | 'unconfigured';
  message: string;
};

type HealthBody = {
  default_model?: string;
  daily?: { limit?: number; used?: number };
};

const TIMEOUT_MS = 6000;

export async function getGatewayStatus(): Promise<GatewayStatus> {
  const base = process.env.ATHENA_GATEWAY_URL?.replace(/\/$/, '');

  if (!base) {
    return {
      state: 'unconfigured',
      message: 'No demo gateway configured — Athena runs fully without one.',
    };
  }

  try {
    const res = await fetch(`${base}/v1/health`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      next: { revalidate: 60 },
    });
    if (!res.ok) throw new Error(`gateway returned ${res.status}`);

    const health = (await res.json()) as HealthBody;
    const model = health.default_model ?? 'a model';
    const limit = health.daily?.limit;
    const used = health.daily?.used;
    const left =
      typeof limit === 'number' && typeof used === 'number'
        ? Math.max(0, limit - used)
        : null;

    return {
      state: 'up',
      message:
        left === null
          ? `Demo gateway is up — ${model}.`
          : `Demo gateway is up — ${model}, ${formatNumber(left)} analyses left today.`,
    };
  } catch {
    // A sleeping gateway is the expected state for a free Railway dyno, not an
    // error worth logging on every render.
    return {
      state: 'down',
      message:
        'Demo gateway is asleep. Athena still runs — the rules tier needs no key.',
    };
  }
}
