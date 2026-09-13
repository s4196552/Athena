import type { FileRecord, TagRecord } from '../data/types';

/* WHICH FILES THE AGENT SHOULD LOOK AT.
 *
 * A port of the QUESTION Verdict.unsure asks in athena/agent/inspect.py:119,
 * not of the arithmetic behind it. The engine decides from scores it computed
 * while reading the file:
 *
 *     return self.topic_score < ESCALATE_BELOW or self.doctype is None
 *
 * Those scores do not exist here and cannot be recovered. The catalogue stores
 * the agent's CONCLUSIONS -- tag ids -- not its working, and the TypeScript
 * taxonomy is a list of names with no lexicon behind it (lib/taxonomy.ts says
 * so). Pretending to recompute a score would be inventing one.
 *
 * What survives the trip is the part that was never a score anyway. `doctype is
 * None` is a fact the catalogue still holds: a file either carries a doctype
 * tag or it does not. So the queue is built from absence, which is exactly the
 * half of `unsure` that is still knowable, and the UI says that is what it is.
 *
 * The ranking below is a priority, not a confidence. It says which file is
 * worth a person's attention first, and nothing about how certain anything is.
 */

export type Gap = 'doctype' | 'topic';

export interface Candidate {
  fileId: string;
  name: string;
  relPath: string;
  parentRel: string;
  ext: string;
  mediaType: string;
  sizeBytes: number;
  mtime: number;
  /** Which axes have no tag at all, after this workspace's lens. */
  gaps: Gap[];
  /** Tags the file does carry, for display. */
  has: { kind: string; display: string }[];
  /** Sort key. Higher means "look at this one first". */
  priority: number;
}

/* Both axes missing is worse than one, and a missing doctype is worse than a
 * missing topic: the engine treats a null doctype as unsure on its own, while
 * a weak topic only matters below a threshold. A file with no tags whatsoever
 * is the worst case and sorts first. */
const WEIGHT: Record<Gap, number> = { doctype: 3, topic: 2 };

export function buildQueue(
  files: FileRecord[],
  tagIdsOf: (f: FileRecord) => number[],
  tagById: Map<number, TagRecord>,
  limit: number,
): Candidate[] {
  const out: Candidate[] = [];

  for (const f of files) {
    const ids = tagIdsOf(f);
    const kinds = new Set<string>();
    const has: { kind: string; display: string }[] = [];

    for (const id of ids) {
      const tag = tagById.get(id);
      if (!tag) continue;
      kinds.add(tag.kind);
      has.push({ kind: tag.kind, display: tag.displayName });
    }

    const gaps: Gap[] = [];
    if (!kinds.has('doctype')) gaps.push('doctype');
    if (!kinds.has('topic')) gaps.push('topic');
    if (!gaps.length) continue;

    let priority = gaps.reduce((sum, g) => sum + WEIGHT[g], 0);
    // Nothing at all known about it: no author, no date, no pattern either.
    if (has.length === 0) priority += 4;
    // A file with a long name in a deep folder gives the agent more to work
    // with than `IMG_0042.jpg` in the root, and is likelier to be decidable.
    if (f.parentRel) priority += 1;

    out.push({
      fileId: f.id,
      name: f.name,
      relPath: f.relPath,
      parentRel: f.parentRel ?? '',
      ext: f.ext,
      mediaType: f.mediaType,
      sizeBytes: f.sizeBytes,
      mtime: f.mtime,
      gaps,
      has: has.slice(0, 6),
      priority,
    });
  }

  // Stable: priority, then name, so the same catalogue always produces the
  // same queue and a reviewer can leave and come back to the same place.
  out.sort((a, b) => b.priority - a.priority || a.relPath.localeCompare(b.relPath));
  return out.slice(0, limit);
}
