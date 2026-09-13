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
  /** How many tags the file carries in total, before `has` is truncated for
   *  display. Shown so the ordering is checkable rather than mysterious. */
  tagCount: number;
}

/* Both axes missing is worse than one, and a missing doctype is worse than a
 * missing topic: the engine treats a null doctype as unsure on its own, while
 * a weak topic only matters below a threshold. How sparse the file is overall
 * is added separately, below. */
const WEIGHT: Record<Gap, number> = { doctype: 3, topic: 2 };

function depthOf(parentRel: string): number {
  return parentRel.split('/').filter(Boolean).length;
}

/** Words a classifier could use. Digits, version stamps and one- or two-letter
 *  fragments are not evidence about what a file is about. */
function wordsIn(name: string): number {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .split(/[^a-z]+/)
    .filter((w) => w.length > 2).length;
}

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

    /* HOW LITTLE IS KNOWN, which is the signal that actually varies.
     *
     * Worth measuring rather than assuming: in the seeded catalogue every
     * single file already carries a doctype, so the gap is always the topic
     * and the weights above are the same for every candidate. Ranking on them
     * alone would have collapsed the queue to alphabetical order while looking
     * like it was prioritising something.
     *
     * What does differ is how much else the file carries. A file known only by
     * its year is a worse position to be in than one with an author, a date and
     * three structural patterns, and it is likelier that a human glance adds
     * something. Sparse files therefore sort first. */
    priority += Math.max(0, 6 - has.length);

    /* EVIDENCE IN THE PATH, which is all the model is ever given.
     *
     * `IMG_0042.jpg` in the library root and
     * `Art_Assets/SolarVanguard/Concept_Art/solarvanguard_lighting_141.psd`
     * are the same problem to the queue above and completely different
     * problems to anything that has to decide them. Sorting the second kind
     * first means a reviewer's model calls land on the files a name and a
     * folder can actually settle, instead of being spent confirming that
     * `IMG_0042.jpg` is undecidable.
     *
     * Capped, because a very deep path is not proportionally more informative
     * and would otherwise dominate the sparsity term. */
    priority += Math.min(2, depthOf(f.parentRel ?? '')) + Math.min(3, wordsIn(f.name));

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
      tagCount: has.length,
      priority,
    });
  }

  // Stable: priority, then name, so the same catalogue always produces the
  // same queue and a reviewer can leave and come back to the same place.
  out.sort((a, b) => b.priority - a.priority || a.relPath.localeCompare(b.relPath));
  return out.slice(0, limit);
}
