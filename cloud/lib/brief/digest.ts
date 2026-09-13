import type { FileRecord, TagRecord } from '../data/types';

/* The arithmetic half of a brief. Ported from digest() in
 * athena/agent/brief.py.
 *
 * It computes once and is used twice: rendered directly when there is no API
 * key, and handed to the model as facts when there is. That ordering is the
 * whole point. Every number a brief states is counted here; the model is given
 * the totals and told not to recompute them, because a summary that is
 * confidently wrong about how many invoices there are is worse than no summary.
 *
 * ONE DELIBERATE OMISSION versus the Python version: no monetary totals. The
 * engine sums `agent_finding.numbers`, extracted from document text. This
 * catalogue has no document text -- the seed is names, sizes, dates and tag
 * ids. A "$27,648 across 11 documents" line would therefore be invented, so it
 * is absent rather than approximated. The `money` pattern tag still appears
 * under what these contain, which is the honest version of the same fact:
 * these documents have monetary amounts in them, and this catalogue does not
 * know what they sum to.
 */

export interface Digest {
  count: number;
  totalBytes: number;
  doctypes: [string, number][];
  topics: [string, number][];
  authors: [string, number][];
  entities: [string, number][];
  years: [string, number][];
  patterns: [string, number][];
  /** Things a person would want to be told before sharing a folder. */
  flags: string[];
  mediaTypes: [string, number][];
  folders: [string, number][];
  earliest: number | null;
  latest: number | null;
  undated: number;
}

/* The patterns worth saying out loud, with the wording to use. Lifted verbatim
 * from NOTABLE in athena/agent/brief.py -- these are warnings about a
 * selection, not facts about it, which is why they get their own section. */
const NOTABLE: Record<string, string> = {
  credentials: 'contain text shaped like API keys, tokens or passwords',
  'national-id': 'contain something shaped like a national ID number',
  iban: 'contain bank account details',
  'date-of-birth': 'contain a date of birth field',
};

function rank(counts: Map<string, number>): [string, number][] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function buildDigest(
  files: FileRecord[],
  tagById: Map<number, TagRecord>,
  tagIdsOf: (f: FileRecord) => number[],
): Digest {
  const by: Record<string, Map<string, number>> = {
    doctype: new Map(), topic: new Map(), author: new Map(),
    entity: new Map(), date: new Map(), pattern: new Map(),
  };
  const media = new Map<string, number>();
  const folders = new Map<string, number>();

  let totalBytes = 0;
  let earliest: number | null = null;
  let latest: number | null = null;
  let dated = 0;

  for (const f of files) {
    totalBytes += f.sizeBytes;
    media.set(f.mediaType, (media.get(f.mediaType) ?? 0) + 1);

    // The top TWO segments. One is "Documents" for half the library; the full
    // path is unique per file and counts to one. Two is where the shape of a
    // selection actually shows -- "Documents/Finance" against "Art_Assets/Echo".
    const top = f.parentRel.split('/').filter(Boolean).slice(0, 2).join('/');
    if (top) folders.set(top, (folders.get(top) ?? 0) + 1);

    if (f.mtime) {
      earliest = earliest === null ? f.mtime : Math.min(earliest, f.mtime);
      latest = latest === null ? f.mtime : Math.max(latest, f.mtime);
    }

    let hasDate = false;
    for (const id of tagIdsOf(f)) {
      const tag = tagById.get(id);
      if (!tag) continue;
      const bucket = by[tag.kind];
      if (!bucket) continue;
      const label = tag.kind === 'date' ? tag.name : tag.displayName;
      bucket.set(label, (bucket.get(label) ?? 0) + 1);
      if (tag.kind === 'date') hasDate = true;
    }
    if (hasDate) dated++;
  }

  const patterns = rank(by.pattern);
  const flags: string[] = [];
  for (const [name, phrase] of Object.entries(NOTABLE)) {
    // Matched on the tag NAME, which is stable, not the display string.
    const hit = [...by.pattern.entries()].find(([label]) =>
      label.toLowerCase().replace(/\s+/g, '-').includes(name));
    if (hit) flags.push(`${hit[1]} ${hit[1] === 1 ? 'file' : 'files'} ${phrase}.`);
  }

  return {
    count: files.length,
    totalBytes,
    doctypes: rank(by.doctype),
    topics: rank(by.topic),
    authors: rank(by.author),
    entities: rank(by.entity),
    // Years read best in order, not by frequency.
    years: rank(by.date).sort((a, b) => a[0].localeCompare(b[0])),
    patterns,
    flags,
    mediaTypes: rank(media),
    folders: rank(folders),
    earliest,
    latest,
    undated: files.length - dated,
  };
}
