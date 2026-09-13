import { API_BASE } from '../lib/api/types.js';
import type { ApiError } from '../lib/api/types.js';
import { loadSession, saveSession, type StoredSession } from './config.mts';

/* The HTTP half of the CLI.
 *
 * Everything it knows about the server's shapes comes from lib/api/types.ts,
 * which the routes import too -- so a field renamed on one side is a type
 * error on both. That is the entire argument for writing this in TypeScript
 * rather than anything else.
 */

export const DEFAULT_BASE = process.env.ATHENA_CLOUD_URL ?? 'https://athena-amber.vercel.app';

export class CliError extends Error {
  constructor(message: string, readonly hint?: string, readonly status?: number) {
    super(message);
    this.name = 'CliError';
  }
}

const COOKIE_NAME = 'athena_session';

/** Pulls our session cookie out of a Set-Cookie header, ignoring the
 *  attributes. Node exposes them individually via getSetCookie(), which is why
 *  this does not need a cookie parser. */
function readSetCookie(res: Response): string | null {
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0 && pair.slice(0, eq).trim() === COOKIE_NAME) {
      const value = pair.slice(eq + 1).trim();
      // An empty value is the server clearing the cookie, not issuing one.
      return value ? `${COOKIE_NAME}=${value}` : null;
    }
  }
  return null;
}

export interface Call {
  method?: 'GET' | 'POST';
  path: string;
  query?: URLSearchParams;
  body?: unknown;
  /** Login is the one call that has no session yet. */
  anonymous?: boolean;
}

export interface Client {
  base: string;
  session: StoredSession | null;
  call<T>(c: Call): Promise<T>;
}

export async function makeClient(baseOverride?: string): Promise<Client> {
  const stored = await loadSession();
  const base = (baseOverride ?? stored?.base ?? DEFAULT_BASE).replace(/\/+$/, '');

  /* A cookie is only sent to the deployment that issued it. Without this a
     `--base http://localhost:3000` run would present a production cookie to a
     dev server, get a 401, and look like a broken login rather than a cookie
     meant for somewhere else. */
  const session = stored && stored.base === base ? stored : null;

  return {
    base,
    session,
    async call<T>(c: Call): Promise<T> {
      if (!c.anonymous) {
        if (!session) {
          throw new CliError(
            'Not signed in.',
            `Run: athena-cloud login${baseOverride ? ` --base ${base}` : ''}`,
          );
        }
        if (session.expiresAt && session.expiresAt < Date.now()) {
          throw new CliError('That session has expired.', 'Run: athena-cloud login');
        }
      }

      const qs = c.query?.toString();
      const url = `${base}${API_BASE}${c.path}${qs ? `?${qs}` : ''}`;

      let res: Response;
      try {
        res = await fetch(url, {
          method: c.method ?? 'GET',
          headers: {
            accept: 'application/json',
            ...(c.body ? { 'content-type': 'application/json' } : {}),
            ...(session && !c.anonymous ? { cookie: session.cookie } : {}),
          },
          body: c.body ? JSON.stringify(c.body) : undefined,
          redirect: 'manual',
        });
      } catch (err) {
        throw new CliError(
          `Could not reach ${base}.`,
          err instanceof Error ? err.message : 'Check the URL and your connection.',
        );
      }

      // A refreshed cookie is kept, so a long-lived session does not expire
      // mid-script when the server re-issues it.
      const fresh = readSetCookie(res);
      if (fresh && session && fresh !== session.cookie) {
        await saveSession({ ...session, cookie: fresh });
      }

      const text = await res.text();

      if (!res.ok) {
        let detail: ApiError | null = null;
        try {
          detail = JSON.parse(text) as ApiError;
        } catch {
          // A non-JSON error body means something in front of the app answered
          // -- a proxy, a platform error page. Say so rather than printing HTML.
        }
        throw new CliError(
          detail?.error ?? `${res.status} from ${url}`,
          detail?.hint
            ?? (res.status === 401 ? 'Run: athena-cloud login' : undefined),
          res.status,
        );
      }

      try {
        return JSON.parse(text) as T;
      } catch {
        throw new CliError('The server did not answer with JSON.', text.slice(0, 120));
      }
    },
  };
}

/** Login is separate because it is the call that CREATES the session, so it
 *  cannot go through the cookie-requiring path above. */
export async function login(
  base: string,
  email: string,
  password?: string,
): Promise<StoredSession> {
  const url = `${base.replace(/\/+$/, '')}${API_BASE}/login`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(password ? { email, password } : { email }),
      redirect: 'manual',
    });
  } catch (err) {
    throw new CliError(
      `Could not reach ${base}.`,
      err instanceof Error ? err.message : undefined,
    );
  }

  const text = await res.text();
  if (!res.ok) {
    let detail: ApiError | null = null;
    try {
      detail = JSON.parse(text) as ApiError;
    } catch { /* fall through to the status */ }
    throw new CliError(detail?.error ?? `Sign-in failed (${res.status}).`, detail?.hint, res.status);
  }

  const cookie = readSetCookie(res);
  if (!cookie) {
    throw new CliError(
      'The server accepted the sign-in but issued no session cookie.',
      'Check GET /api/health — an unset AUTH_SECRET presents exactly like this.',
    );
  }

  const me = JSON.parse(text) as {
    user: { email: string; name: string };
    expiresAt: number;
    workspaces: { slug: string }[];
  };

  return {
    base: base.replace(/\/+$/, ''),
    cookie,
    email: me.user.email,
    name: me.user.name,
    expiresAt: me.expiresAt,
    // Only when there is no ambiguity. Guessing for a member of three
    // workspaces would silently pick one and quietly answer about the wrong
    // catalogue for every later command.
    ...(me.workspaces.length === 1 ? { workspace: me.workspaces[0].slug } : {}),
  };
}
