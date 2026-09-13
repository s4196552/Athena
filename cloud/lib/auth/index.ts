import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { sign, verify, cookieName, cookieOptions } from './cookie';
import { mockProvider } from './providers/mock';
import { getRepository } from '../data';
import type { AuthProvider, Session, SignUpInput, AuthResult } from './types';
import type { UserId, WorkspaceId } from '../data/types';

/* THE AUTH BOUNDARY.
 *
 * Every caller in the app imports from this file and nothing else. No page, no
 * component and no server action imports a provider directly -- eslint.config
 * enforces that so the boundary cannot rot quietly.
 *
 * Swapping in NextAuth, Clerk or Supabase means changing the one line below
 * and writing a new providers/*.ts. The six exported functions keep their
 * signatures, so nothing above this line moves.
 */
const provider: AuthProvider = mockProvider;

export type { Session, SignUpInput, AuthResult } from './types';

// ---------------------------------------------------------------------------
//  Reading
// ---------------------------------------------------------------------------

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const claims = await verify(jar.get(cookieName)?.value);
  if (!claims) return null;

  const user = await provider.loadUser(claims.uid as UserId);
  if (!user) return null;

  return {
    user,
    orgId: (claims.oid as Session['orgId']) ?? null,
    workspaceId: (claims.wid as Session['workspaceId']) ?? null,
    expiresAt: claims.exp * 1000,
  };
}

/** Redirects to /login rather than returning null. Use in any page that has
 *  nothing to render for a signed-out visitor. */
export async function requireSession(nextPath?: string): Promise<Session> {
  const session = await getSession();
  if (session) return session;
  const q = nextPath ? `?next=${encodeURIComponent(nextPath)}` : '';
  redirect(`/login${q}`);
}

// ---------------------------------------------------------------------------
//  Writing
// ---------------------------------------------------------------------------

/** True when the throw came from an unset AUTH_SECRET rather than a real
 *  failure. Worth distinguishing: it is a deployment mistake with a specific
 *  fix, and surfacing it as "something went wrong" wastes an afternoon. */
function isMisconfigured(err: unknown): boolean {
  return err instanceof Error && err.message.includes('AUTH_SECRET');
}

async function issue(userId: UserId, workspaceId: WorkspaceId | null): Promise<Session | null> {
  const repo = getRepository();
  const user = await provider.loadUser(userId);
  if (!user) return null;

  let orgId: Session['orgId'] = null;
  let wid: WorkspaceId | null = workspaceId;

  if (!wid) {
    // Drop the user straight into their only workspace when there is exactly
    // one; otherwise leave it unset and let /app/select ask.
    const mine = await repo.listWorkspacesForUser(userId);
    if (mine.length === 1) wid = mine[0].id;
  }
  if (wid) {
    const ws = (await repo.listWorkspacesForUser(userId)).find((w) => w.id === wid);
    if (!ws) return null;
    orgId = ws.orgId;
  }

  const token = await sign({ uid: userId, oid: orgId, wid });
  (await cookies()).set(cookieName, token, cookieOptions());

  return { user, orgId, workspaceId: wid, expiresAt: Date.now() + 7 * 864e5 };
}

export async function signIn(email: string, password?: string): Promise<AuthResult> {
  if (!email.trim()) return { ok: false, error: 'Enter an email address.' };

  const user = await provider.verifyCredentials(email, password);
  if (!user) {
    return {
      ok: false,
      error: 'No account with that email. Try one of the demo accounts below.',
    };
  }

  try {
    const session = await issue(user.id, null);
    return session
      ? { ok: true, session }
      : { ok: false, error: 'Could not start a session.' };
  } catch (err) {
    if (isMisconfigured(err)) {
      return {
        ok: false,
        error:
          'This deployment is missing AUTH_SECRET, so sessions cannot be signed. '
          + 'Set it in the hosting environment and redeploy — see /api/health.',
      };
    }
    throw err;
  }
}

/** Not reachable from the UI: the demo has no sign-up, because there are no
 *  real accounts to create. Kept because it is part of the boundary a real
 *  provider has to implement, and deleting it would only mean writing it
 *  again. */
export async function signUp(input: SignUpInput): Promise<AuthResult> {
  if (!input.email.includes('@')) return { ok: false, error: 'That does not look like an email address.' };
  if (input.password.length < 6) return { ok: false, error: 'Use at least six characters.' };

  let user;
  try {
    user = await provider.createUser(input);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not create the account.' };
  }

  try {
    const session = await issue(user.id, null);
    return session
      ? { ok: true, session }
      : { ok: false, error: 'Account created, but the session could not start.' };
  } catch (err) {
    if (isMisconfigured(err)) {
      return {
        ok: false,
        error:
          'This deployment is missing AUTH_SECRET, so sessions cannot be signed. '
          + 'Set it in the hosting environment and redeploy — see /api/health.',
      };
    }
    throw err;
  }
}

export async function signOut(): Promise<void> {
  (await cookies()).delete(cookieName);
}

/** Re-signs the cookie with a different active workspace. The membership check
 *  matters: without it, editing `wid` would be a tenancy hole. */
export async function switchWorkspace(workspaceId: WorkspaceId): Promise<boolean> {
  const session = await getSession();
  if (!session) return false;

  const allowed = await getRepository().listWorkspacesForUser(session.user.id);
  if (!allowed.some((w) => w.id === workspaceId)) return false;

  return (await issue(session.user.id, workspaceId)) !== null;
}

/** Seeded accounts for the login screen's one-click chips. */
export async function demoAccounts() {
  return provider.demoUsers();
}
