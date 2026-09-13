import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { getRepository } from '@/lib/data';

export const dynamic = 'force-dynamic';

/* Resolver, not a page. Sends you to the workspace the cookie remembers, or to
 * the picker when there is a real choice to make. */
export default async function AppIndex() {
  const session = await requireSession('/app');
  const repo = getRepository();
  const mine = await repo.listWorkspacesForUser(session.user.id);

  if (mine.length === 0) redirect('/app/select');

  const active = session.workspaceId
    ? mine.find((w) => w.id === session.workspaceId)
    : undefined;

  redirect(`/w/${(active ?? mine[0]).slug}`);
}
