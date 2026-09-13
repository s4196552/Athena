import type { WorkspaceContext } from './repository';
import type { FileRecord, TagId } from './types';

/* What one workspace sees on one file, resolved once.
 *
 * The repository applies this lens internally at `tagIdsOf` -- the chokepoint
 * that makes counts, facets, filters, the summary and both graph modes agree
 * without knowing the overlay exists. But `listFiles` hands back raw
 * FileRecords, so anything that RENDERS tags has to reapply it, and until this
 * module existed each caller did that by hand.
 *
 * They did not agree. The library page built its chips from
 * `[...f.tags, ...userTags]` and never consulted `ctx.addedTags`, while the
 * agent page did -- so a tag accepted from the agent was counted in the facet
 * rail and absent from the file it had been accepted onto. The bug is the
 * ordinary consequence of writing the same five lines in three places, and the
 * fix is to stop doing that rather than to correct the third copy.
 */

export interface LensedTag {
  id: number;
  kind: string;
  name: string;
  display: string;
  /** True when this workspace put the tag there -- its own user tag, or a
   *  suggestion it accepted from the agent. Both are an opinion this team
   *  holds rather than a fact about the content, which is exactly the
   *  distinction the UI marks. */
  user: boolean;
}

export interface LensedTags {
  tags: LensedTag[];
  /** Tags the catalogue holds that this workspace has chosen not to count.
   *  Kept rather than dropped: the panel has to show a suppressed tag in order
   *  to offer the undo, and the repository has already removed it everywhere
   *  else. */
  removed: LensedTag[];
}

export function lensedTags(
  ctx: WorkspaceContext,
  f: FileRecord,
  tagById: Map<number, { kind: string; name: string; displayName: string }>,
): LensedTags {
  const own = (f.userTags ?? [])
    .filter((u) => u.workspaceId === ctx.workspace.id)
    .map((u) => u.tagId as number);

  const accepted = [...(ctx.addedTags?.(f.id) ?? [])] as number[];
  const mine = new Set([...own, ...accepted]);

  const tags: LensedTag[] = [];
  const removed: LensedTag[] = [];

  // A Set over the union, because a workspace can accept a tag the catalogue
  // already carries and the chip must not then appear twice.
  for (const id of new Set<number>([...(f.tags as unknown as number[]), ...mine])) {
    const t = tagById.get(id);
    if (!t) continue;
    const view: LensedTag = {
      id,
      kind: t.kind,
      name: t.name,
      display: t.displayName,
      user: mine.has(id),
    };
    (ctx.isRemoved(f.id, id as TagId) ? removed : tags).push(view);
  }

  return { tags, removed };
}
