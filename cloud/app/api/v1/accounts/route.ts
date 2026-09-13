import { demoAccounts } from '@/lib/auth';
import { DEMO_AUTH } from '@/lib/auth/mode';
import { getRepository } from '@/lib/data';
import { apiJson, fail } from '@/lib/api/route';
import type { AccountsResponse } from '@/lib/api/types';

/* The sign-in picker, for a client that has no screen to show it on.
 *
 * Public, and only while DEMO_AUTH is true. That is not a loosening: /login is
 * already a picker over these same accounts and hands out a session for any of
 * them on request, so the list is published by the deployment either way. The
 * gate below is what makes that stay true -- the moment accounts are real this
 * returns 404 rather than enumerating users, which is the thing it would
 * otherwise quietly become.
 *
 * It exists because the alternative is a hardcoded list in the CLI, and a
 * hardcoded list drifts: the first draft of this tool shipped five addresses
 * at `@hadesmedia.test` when the fixtures are at `@hadesmedia.example`, so
 * every one of them failed to log in.
 */

export async function GET() {
  if (!DEMO_AUTH) {
    return fail(
      404,
      'This deployment does not publish a list of accounts.',
      'Sign in with your own email and password.',
    );
  }

  const repo = getRepository();
  const users = await demoAccounts();

  const accounts = await Promise.all(
    users.map(async (u) => {
      const workspaces = await repo.listWorkspacesForUser(u.id);
      return {
        email: u.email,
        name: u.name,
        // What each account is FOR. A list of five addresses with no
        // distinction between them makes the reader pick the first one, and
        // the interesting thing about this demo is that they see different
        // catalogues.
        workspaces: workspaces.map((w) => w.slug),
      };
    }),
  );

  return apiJson<AccountsResponse>({ accounts, passwordRequired: false });
}
