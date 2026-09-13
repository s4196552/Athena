import { signIn } from '@/lib/auth';
import { describeUser } from '@/lib/api/identity';
import { apiJson, fail } from '@/lib/api/route';
import { DEMO_AUTH } from '@/lib/auth/mode';
import type { LoginRequest, MeResponse } from '@/lib/api/types';
import type { UserId } from '@/lib/data/types';

/* Signing in without a browser.
 *
 * The web login is a server action, which a CLI cannot call: server actions
 * are addressed by a build-time id and posted with a framework header, and
 * anything reproducing that by hand would break on the next build. So this is
 * the same `signIn` behind an ordinary POST.
 *
 * IT IS NOT A WEAKER DOOR THAN /login. The password is passed straight through
 * to the provider rather than being inspected here, which means the strength
 * of this endpoint is exactly the strength of `provider.verifyCredentials` --
 * today mockProvider, which accepts any of the seeded fixture emails without a
 * password, because /login is a PICKER over those same accounts and hands out
 * the identical session on request. The moment `provider` becomes real, this
 * route requires a real password with no change to it, which is the property
 * worth having.
 *
 * The one thing added here is the refusal below: if this deployment ever runs
 * on real accounts and someone posts no password, it is rejected outright
 * rather than relying on the provider to notice.
 */

export async function POST(request: Request) {
  let body: LoginRequest;
  try {
    body = (await request.json()) as LoginRequest;
  } catch {
    return fail(400, 'Send a JSON body.', 'For example: {"email":"iris@hadesmedia.test"}');
  }

  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : undefined;

  if (!email) {
    return fail(400, 'An email address is required.', 'Try `athena-cloud accounts`.');
  }

  if (!DEMO_AUTH && !password) {
    return fail(
      400,
      'A password is required on this deployment.',
      'Fixture sign-in is off here, so an email alone is not a credential.',
    );
  }

  const result = await signIn(email, password);
  if (!result.ok) {
    /* 401 for a bad credential, 503 for a server that cannot sign anything:
       a CLI retrying a missing AUTH_SECRET forever would be the wrong
       behaviour, and the two are indistinguishable without the split. */
    const misconfigured = result.error.includes('AUTH_SECRET');
    return fail(
      misconfigured ? 503 : 401,
      result.error,
      misconfigured ? 'See GET /api/health.' : undefined,
    );
  }

  // signIn set the cookie on this response already. The body is `me`, so a
  // client needs one call to sign in and know where it can go.
  return apiJson<MeResponse>(
    await describeUser(result.session.user.id as UserId, result.session.expiresAt),
  );
}
