import 'server-only';
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { workspaceContext } from '@/lib/data/context';
import type { Session } from '@/lib/auth';
import type { ApiError } from './types';

/* The four things every /api/v1 route does before it does its own job.
 *
 * Pulled out because the alternative is nine routes each re-deciding what a
 * signed-out caller gets, and the failure mode of getting that wrong once is
 * an endpoint that answers a stranger. The page equivalents cannot share this:
 * `requireSession` REDIRECTS, which is right for a page and useless to a CLI,
 * which would follow the 307 and try to parse a login screen as JSON.
 */

export function fail(status: number, error: string, hint?: string) {
  return NextResponse.json<ApiError>(hint ? { error, hint } : { error }, { status });
}

/* 404 rather than 403 for a workspace the caller is not in, matching the page
 * behaviour exactly. Telling a stranger that `hadesmedia-finance` exists but
 * is not theirs is a smaller leak than the catalogue behind it and still a
 * leak: it confirms a customer's name. */
export const NOT_A_MEMBER = 'No such workspace, or you are not a member of it.';

export type ApiContext = NonNullable<Awaited<ReturnType<typeof workspaceContext>>>;

/** Resolves the session, or returns the response to send instead. The caller
 *  writes `if ('response' in gate) return gate.response;`, which keeps the
 *  early return visible at the top of each route rather than hidden in a
 *  wrapper that also owns the happy path. */
export async function apiSession(): Promise<
  { session: Session } | { response: NextResponse }
> {
  const session = await getSession();
  if (!session) {
    return {
      response: fail(
        401,
        'Not signed in.',
        'Run `athena-cloud login` first, or send the athena_session cookie.',
      ),
    };
  }
  return { session };
}

/** Session plus a workspace the caller actually belongs to. */
export async function apiWorkspace(
  ws: string,
): Promise<{ session: Session; ctx: ApiContext } | { response: NextResponse }> {
  const gate = await apiSession();
  if ('response' in gate) return gate;

  const ctx = await workspaceContext(gate.session.user.id, ws);
  if (!ctx) {
    return {
      response: fail(404, NOT_A_MEMBER, 'Run `athena-cloud workspaces` to see yours.'),
    };
  }
  return { session: gate.session, ctx };
}

/* Every v1 route is per-caller by construction -- the answer depends on a
 * session cookie and a per-workspace overlay -- so a shared cache anywhere in
 * front of them would serve one workspace's catalogue to another. Said once,
 * here, rather than remembered nine times. */
export function apiJson<T>(data: T, status = 200) {
  return NextResponse.json<T>(data, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
