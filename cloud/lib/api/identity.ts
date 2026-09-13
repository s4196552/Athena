import 'server-only';
import { getRepository } from '@/lib/data';
import type { MeResponse } from './types';
import type { UserId } from '@/lib/data/types';

/* "Who am I and where can I go?" -- shared by POST /api/v1/login and
 * GET /api/v1/me, because a client that has just signed in should not have to
 * make a second call to learn the same thing.
 *
 * It lives here rather than in either route because a Next route module may
 * only export HTTP handlers; anything else exported from one fails the build's
 * route type check.
 */
export async function describeUser(userId: UserId, expiresAt: number): Promise<MeResponse> {
  const repo = getRepository();
  const user = await repo.getUserById(userId);
  const workspaces = await repo.listWorkspacesForUser(userId);

  /* Counts per workspace, through each workspace's OWN context -- so the
     number beside `hadesmedia-finance` is what Finance can see, not what the
     library holds. Building a context per workspace is more work than reading
     a column would be, and it is the only way the number is true: the whole
     point of this app is that two workspaces sharing a catalogue see
     different amounts of it. */
  const rows = await Promise.all(
    workspaces.map(async (w) => {
      const ctx = await repo.buildContext(userId, w.slug);
      const counts = ctx ? await repo.summary(ctx) : null;
      return {
        slug: w.slug,
        name: w.name,
        role: ctx?.role ?? 'none',
        files: counts?.files ?? 0,
        tags: counts?.tags ?? 0,
      };
    }),
  );

  return {
    user: { id: String(userId), name: user?.name ?? '', email: user?.email ?? '' },
    workspaces: rows,
    expiresAt,
  };
}
