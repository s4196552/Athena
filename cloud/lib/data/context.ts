import 'server-only';
import { getRepository } from './index';
import { readOverlay } from '../overlay/store';
import type { WorkspaceContext } from './repository';
import type { UserId } from './types';

/* The one way a page or route builds a workspace context.
 *
 * It exists so the overlay is never forgotten. `repo.buildContext` still takes
 * it as an argument -- the driver must stay free of next/headers to remain
 * testable and portable -- but forgetting to pass it would not fail loudly, it
 * would just quietly show a tag the viewer had already removed. One helper
 * that every caller uses is cheaper than remembering.
 */
export async function workspaceContext(
  userId: UserId,
  workspaceSlug: string,
): Promise<WorkspaceContext | null> {
  const repo = getRepository();
  const workspace = await repo.getWorkspaceBySlug(workspaceSlug);
  // No such slug: skip the cookie read and let buildContext return the null
  // that becomes a 404. Reading an overlay for a workspace that may not exist
  // would also mean trusting a slug from the URL to name a cookie.
  if (!workspace) return repo.buildContext(userId, workspaceSlug);

  const overlay = await readOverlay(workspace.id);
  return repo.buildContext(userId, workspaceSlug, overlay);
}
