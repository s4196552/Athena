import type { FileRecord, TagRecord } from '../data/types';
import {
  GRAPH_KINDS, MAX_TAG_NODES, MAX_TAG_EDGES, MAX_PER_KIND, MIN_EDGE_WEIGHT,
} from './constants';

/* A co-occurrence graph over the current selection.
 *
 * A direct port of graph() in athena/web/queries.py:417-521. Nodes are *tags*,
 * not files, and that is the whole design decision: a node per file gives a
 * 100,000-point cloud that renders slowly and says nothing; a node per tag
 * gives forty points whose shape is the actual structure of the library --
 * Finance sitting between Invoice and one author, a cluster of Legal that
 * touches nothing else.
 *
 * An edge means "these two tags appear on the same file". It carries two
 * numbers, and the difference between them is what makes the picture worth
 * looking at:
 *
 *   weight   -- how many files. What the tooltip shows, because it is the
 *               number a person can check.
 *   strength -- weight / min(count(a), count(b)), so 1.0 means "wherever the
 *               rarer of these two appears, the other one does too".
 *
 * The layout pulls on `strength`, not on `weight`. Ranking by raw count
 * produces a graph whose strongest links are simply its commonest tags: on a
 * real library the top edges were all "2024 -- something", because nearly
 * every file has a year and a year therefore co-occurs with everything. That
 * is not a relationship, it is a base rate. Normalising by the rarer endpoint
 * surfaces the actual structure instead.
 */

export interface TagNode {
  tid: number;
  kind: string;
  label: string;
  name: string;
  /** Files in the selection carrying this tag. */
  n: number;
}

export interface TagEdge {
  source: number;
  target: number;
  weight: number;
  strength: number;
}

export interface TagGraph {
  nodes: TagNode[];
  edges: TagEdge[];
  files: number;
}

export interface TagGraphOptions {
  /** Edge budget. The default keeps the picture legible; the pyramid raises it
   *  because a dropped pair there is not a missing line, it is a missing
   *  level. */
  maxEdges?: number;
}

export function buildTagGraph(
  files: FileRecord[],
  tagById: Map<number, TagRecord>,
  tagIdsOf: (f: FileRecord) => number[],
  options: TagGraphOptions = {},
): TagGraph {
  const maxEdges = options.maxEdges ?? MAX_TAG_EDGES;
  const kinds = new Set<string>(GRAPH_KINDS);

  // --- count, restricted to the drawable kinds
  const counts = new Map<number, number>();
  const perFile: number[][] = new Array(files.length);

  for (let i = 0; i < files.length; i++) {
    const ids = [...new Set(tagIdsOf(files[i]))].filter((id) => {
      const t = tagById.get(id);
      return t && kinds.has(t.kind);
    });
    perFile[i] = ids;
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  // --- rank: per-kind cap first, then the global budget in kind priority
  //     order. Capping per kind is what keeps the picture MIXED, which is the
  //     only way it shows structure.
  const byKind = new Map<string, { tid: number; n: number; t: TagRecord }[]>();
  for (const [tid, n] of counts) {
    const t = tagById.get(tid)!;
    if (!byKind.has(t.kind)) byKind.set(t.kind, []);
    byKind.get(t.kind)!.push({ tid, n, t });
  }

  const chosen: TagNode[] = [];
  for (const kind of GRAPH_KINDS) {
    const list = (byKind.get(kind) ?? [])
      .sort((a, b) => b.n - a.n || a.t.displayName.localeCompare(b.t.displayName))
      .slice(0, MAX_PER_KIND);
    for (const { tid, n, t } of list) {
      chosen.push({ tid, kind: t.kind, label: t.displayName, name: t.name, n });
    }
  }
  const nodes = chosen.slice(0, MAX_TAG_NODES);

  if (nodes.length < 2) return { nodes, edges: [], files: files.length };

  // --- co-occurrence among the chosen tags
  const keep = new Set(nodes.map((x) => x.tid));
  const nById = new Map(nodes.map((x) => [x.tid, x.n]));
  const pair = new Map<string, number>();

  for (const ids of perFile) {
    const present = ids.filter((id) => keep.has(id)).sort((a, b) => a - b);
    for (let a = 0; a < present.length; a++) {
      for (let b = a + 1; b < present.length; b++) {
        const key = `${present[a]}:${present[b]}`;
        pair.set(key, (pair.get(key) ?? 0) + 1);
      }
    }
  }

  const edges: TagEdge[] = [];
  for (const [key, weight] of pair) {
    if (weight < MIN_EDGE_WEIGHT) continue;
    const [source, target] = key.split(':').map(Number);
    const strength = weight / Math.min(nById.get(source)!, nById.get(target)!);
    edges.push({ source, target, weight, strength: Math.round(strength * 1e4) / 1e4 });
  }

  edges.sort((a, b) => b.strength - a.strength || b.weight - a.weight);

  return { nodes, edges: edges.slice(0, maxEdges), files: files.length };
}
