import type { FileRecord, LibraryGraph, TagRecord } from '../data/types';
import { DEFAULT_FILE_NODES } from './constants';

/* The file-level graph: the Obsidian-style cloud.
 *
 * Nothing here computes k-NN. The edges and the layout were both built once,
 * offline, by scripts/build-graph.mts. This function only INDUCES the subgraph
 * for the current selection -- keep a node if it is selected, keep an edge if
 * both its ends survived. That is O(V + E) rather than O(V^2).
 *
 * The induced subgraph is deliberately not the same as re-running k-NN within
 * the selection. It is far cheaper, and it has the better property for a UI: a
 * node keeps its neighbours as you filter, so the picture MORPHS rather than
 * reshuffling, and you can follow a cluster you were looking at.
 */

export interface FileGraphPayload {
  /** Node index -> file id. */
  ids: string[];
  labels: string[];
  paths: string[];
  exts: string[];
  mediaTypes: string[];
  /** Degree within the induced subgraph. Drives node radius. */
  degree: number[];
  /** Precomputed coordinates, carried straight through. */
  x: number[];
  y: number[];
  /** Flat [src, tgt, src, tgt, ...] of node indices. */
  edges: number[];
  /** Similarity 0..255. */
  weights: number[];
  /** CSR tag matrix: tagIndices[tagOffsets[i] .. tagOffsets[i+1]] are node i's
   *  entries in tagTable. Kept columnar so recolouring is arithmetic on the
   *  client and never needs a refetch. */
  tagOffsets: number[];
  tagIndices: number[];
  tagTable: { kind: string; name: string; label: string }[];
  truncated: { shown: number; total: number } | null;
}

export function induceFileGraph(
  selected: FileRecord[],
  full: LibraryGraph,
  tagById: Map<number, TagRecord>,
  tagIdsOf: (f: FileRecord) => number[],
  limit: number = DEFAULT_FILE_NODES,
): FileGraphPayload {
  // --- map file id -> index in the precomputed graph
  const indexOf = new Map<string, number>();
  for (let i = 0; i < full.ids.length; i++) indexOf.set(full.ids[i], i);

  const selectedSet = new Set(selected.map((f) => f.id));

  // --- degree within the selection, so the cap keeps the most connected
  //     nodes rather than an arbitrary slice
  const localDegree = new Map<string, number>();
  for (const id of selectedSet) localDegree.set(id, 0);

  const kept: [number, number][] = [];
  for (let e = 0; e < full.weights.length; e++) {
    const a = full.edges[e * 2];
    const b = full.edges[e * 2 + 1];
    const ida = full.ids[a];
    const idb = full.ids[b];
    if (!selectedSet.has(ida) || !selectedSet.has(idb)) continue;
    kept.push([e, 0]);
    localDegree.set(ida, localDegree.get(ida)! + 1);
    localDegree.set(idb, localDegree.get(idb)! + 1);
  }

  /* --- choose nodes.
   *
   * Ranking purely by degree gives a truncated view made entirely of the
   * well-connected core, which misrepresents the library: the unconnected
   * files -- the ones that orbit the perimeter -- are exactly what a degree
   * sort deletes first. On the seeded catalogue that turned 224 genuine
   * orphans into 35 survivors, and the rim went with them.
   *
   * So the budget is split to preserve the SHAPE: orphans keep a share of it
   * proportional to how many there really are, and the connected nodes are
   * still taken by descending degree. Ties break on id so the choice is stable
   * across requests and the picture does not reshuffle on reload.
   */
  const connected: FileRecord[] = [];
  const orphans: FileRecord[] = [];
  for (const f of selected) {
    ((localDegree.get(f.id) ?? 0) === 0 ? orphans : connected).push(f);
  }

  const byDegree = (p: FileRecord, q: FileRecord) => {
    const d = (localDegree.get(q.id) ?? 0) - (localDegree.get(p.id) ?? 0);
    return d !== 0 ? d : p.id.localeCompare(q.id);
  };
  connected.sort(byDegree);
  orphans.sort((p, q) => p.id.localeCompare(q.id));

  const truncated = selected.length > limit;
  let chosen: FileRecord[];

  if (!truncated) {
    chosen = [...connected, ...orphans];
  } else {
    const orphanShare = orphans.length / selected.length;
    const orphanBudget = Math.min(orphans.length, Math.round(limit * orphanShare));
    // Evenly spaced rather than the first N, so the sample is not biased by
    // whatever order ids happen to sort in.
    const stride = orphans.length / Math.max(orphanBudget, 1);
    const keptOrphans = Array.from(
      { length: orphanBudget },
      (_, i) => orphans[Math.floor(i * stride)],
    );
    chosen = [...connected.slice(0, limit - orphanBudget), ...keptOrphans];
  }

  const nodeIndex = new Map<string, number>();
  chosen.forEach((f, i) => nodeIndex.set(f.id, i));

  // --- tag table, built only over tags actually present on chosen nodes
  const tagSlot = new Map<number, number>();
  const tagTable: FileGraphPayload['tagTable'] = [];
  const tagOffsets: number[] = [0];
  const tagIndices: number[] = [];

  for (const f of chosen) {
    for (const id of tagIdsOf(f)) {
      const t = tagById.get(id);
      if (!t) continue;
      let slot = tagSlot.get(id);
      if (slot === undefined) {
        slot = tagTable.length;
        tagSlot.set(id, slot);
        tagTable.push({ kind: t.kind, name: t.name, label: t.displayName });
      }
      tagIndices.push(slot);
    }
    tagOffsets.push(tagIndices.length);
  }

  // --- edges, re-indexed onto the chosen nodes
  const edges: number[] = [];
  const weights: number[] = [];
  const degree = new Array<number>(chosen.length).fill(0);

  for (const [e] of kept) {
    const a = nodeIndex.get(full.ids[full.edges[e * 2]]);
    const b = nodeIndex.get(full.ids[full.edges[e * 2 + 1]]);
    if (a === undefined || b === undefined) continue;
    edges.push(a, b);
    weights.push(full.weights[e]);
    degree[a]++;
    degree[b]++;
  }

  return {
    ids: chosen.map((f) => f.id),
    labels: chosen.map((f) => f.name),
    paths: chosen.map((f) => f.relPath),
    exts: chosen.map((f) => f.ext),
    mediaTypes: chosen.map((f) => f.mediaType),
    degree,
    x: chosen.map((f) => full.x[indexOf.get(f.id)!] ?? 0),
    y: chosen.map((f) => full.y[indexOf.get(f.id)!] ?? 0),
    edges,
    weights,
    tagOffsets,
    tagIndices,
    tagTable,
    truncated: truncated ? { shown: chosen.length, total: selected.length } : null,
  };
}
