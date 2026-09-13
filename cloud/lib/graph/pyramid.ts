import { MIN_CONTAINMENT, MIN_LOOSE_ROW, PYRAMID_PITCH, PYRAMID_ROW } from './constants';

/* The pyramid: the tag graph drawn as a hierarchy instead of a cloud.
 *
 * The tag graph answers "what goes with what". It is a force layout, so where
 * a node ends up is an accident of the simulation -- two runs of the same data
 * give two pictures, and neither has an up or a down. That is the right shape
 * for a similarity cloud and the wrong one for the question people actually
 * arrive with, which is "what is this library ABOUT, and what sits under
 * that".
 *
 * So this view draws a different relation over the same selection:
 *
 *   CO-OCCURRENCE is symmetric.  Finance and Invoice appear together.
 *   CONTAINMENT is not.          Nearly every Invoice is Finance; most Finance
 *                                files are not Invoices. Finance is therefore
 *                                the broader tag, and that is a fact about the
 *                                data rather than a taxonomy someone declared.
 *
 * Containment of a child in a parent is |both| / |child|, so 0.9 reads as
 * "nine in ten files with the child tag also carry the parent". Above the
 * threshold the pair becomes a directed edge; the result is a DAG, and the
 * drawing is a Sugiyama-style layered one:
 *
 *   1. direct every qualifying pair from the more general tag to the more
 *      specific, which makes the graph acyclic BY CONSTRUCTION (see `rank`);
 *   2. transitively reduce it, so Invoice hangs off Finance rather than off
 *      Finance AND every ancestor of Finance;
 *   3. layer by longest path from a root, so a node always sits below every
 *      one of its parents;
 *   4. order each row by the barycentre heuristic to cut edge crossings;
 *   5. position by pulling children under their parents, with a minimum pitch.
 *
 * Levels get wider as they get more specific -- there are more kinds of
 * invoice than there are kinds of money -- which is where the silhouette, and
 * the name, come from. The shape is emergent, not drawn: if a library really
 * is a flat pile of unrelated tags, this view says so by showing one row.
 *
 * Everything here is pure and runs in about a millisecond at the 60-node cap,
 * which is why the thresholds are sliders rather than server parameters: the
 * whole hierarchy is rebuilt while the handle is still moving.
 */

export interface PyramidNodeInput {
  /** Stable tag id, matching the ids used in `edges`. */
  tid: number;
  /** Files in the selection carrying this tag. */
  n: number;
}

export interface PyramidEdgeInput {
  source: number;
  target: number;
  /** Files carrying both tags. */
  weight: number;
}

export interface PyramidOptions {
  /** 0..1. How much of the child has to sit inside the parent. */
  containment?: number;
  /** World units between rows. */
  rowHeight?: number;
  /** Minimum world units between neighbours in a row. */
  pitch?: number;
}

export interface PyramidEdge {
  /** Node indices, not tag ids. */
  parent: number;
  child: number;
  /** Files carrying both. */
  weight: number;
  /** weight / n(child), 0..1. */
  containment: number;
}

export interface PyramidLayer {
  depth: number;
  /** Node indices, left to right. */
  nodes: number[];
  y: number;
  label: string;
  /** The trailing rows: tags no containment edge touched. */
  unattached: boolean;
  /** A second or later row of the same group, so the caption is not repeated
   *  down the side of the drawing. */
  continues: boolean;
  /** Nodes in the whole group this row belongs to, which for a wrapped one is
   *  more than it holds. */
  groupSize: number;
}

export interface Pyramid {
  /** Row index per node. */
  depth: number[];
  x: number[];
  y: number[];
  parents: number[][];
  children: number[][];
  /** Edges kept after reduction, parent first. */
  edges: PyramidEdge[];
  layers: PyramidLayer[];
  /** Deepest attached row, or -1 when nothing is attached. */
  maxDepth: number;
}

/** Two sweeps each way. A third changes almost nothing at 60 nodes, and the
 *  heuristic does not improve monotonically, so more is not automatically
 *  better. */
const SWEEPS = 2;

export function buildPyramid(
  nodes: PyramidNodeInput[],
  edges: PyramidEdgeInput[],
  options: PyramidOptions = {},
): Pyramid {
  const threshold = options.containment ?? MIN_CONTAINMENT;
  const rowHeight = options.rowHeight ?? PYRAMID_ROW;
  const pitch = options.pitch ?? PYRAMID_PITCH;
  const count = nodes.length;

  if (count === 0) {
    return { depth: [], x: [], y: [], parents: [], children: [], edges: [], layers: [], maxDepth: -1 };
  }

  const indexOf = new Map<number, number>();
  nodes.forEach((node, i) => indexOf.set(node.tid, i));

  /* Generality rank: descending file count, ties broken by tag id.
   *
   * This is a TOTAL order, and every edge is directed from the lower rank to
   * the higher one, so a cycle would need an index to precede itself. There is
   * therefore no cycle-breaking pass in this file, and its absence is load
   * bearing -- cycle breaking is where layered layouts usually acquire their
   * "why did that edge flip" bugs. */
  const rank = new Array<number>(count);
  const byGenerality = nodes
    .map((_, i) => i)
    .sort((a, b) => nodes[b].n - nodes[a].n || nodes[a].tid - nodes[b].tid);
  byGenerality.forEach((i, position) => { rank[i] = position; });

  // --- 1. candidate edges ---------------------------------------------------
  const children: number[][] = Array.from({ length: count }, () => []);
  const parents: number[][] = Array.from({ length: count }, () => []);
  const candidates: PyramidEdge[] = [];

  for (const edge of edges) {
    const a = indexOf.get(edge.source);
    const b = indexOf.get(edge.target);
    if (a === undefined || b === undefined || a === b) continue;

    const parent = rank[a] < rank[b] ? a : b;
    const child = parent === a ? b : a;
    const size = nodes[child].n;
    if (size <= 0) continue;

    const containment = Math.min(1, edge.weight / size);
    if (containment < threshold) continue;

    candidates.push({ parent, child, weight: edge.weight, containment });
    children[parent].push(child);
    parents[child].push(parent);
  }

  // --- 2. transitive reduction ---------------------------------------------
  /* Drop parent -> child wherever the parent already reaches the child the
     long way round. Without this, every tag in a chain hangs off every tag
     above it and the drawing is a fan rather than a hierarchy.

     Reachability is computed over the FULL candidate set, in reverse
     generality order so that a node's descendants are known before it is
     visited. Reduction preserves reachability, so the layering below is the
     same either way -- it is the picture that needs this, not the maths. */
  const reach: Set<number>[] = Array.from({ length: count }, () => new Set<number>());
  for (let p = byGenerality.length - 1; p >= 0; p--) {
    const i = byGenerality[p];
    for (const c of children[i]) {
      reach[i].add(c);
      for (const d of reach[c]) reach[i].add(d);
    }
  }

  const kept = candidates.filter(({ parent, child }) =>
    !children[parent].some((via) => via !== child && reach[via].has(child)));

  for (let i = 0; i < count; i++) { children[i] = []; parents[i] = []; }
  for (const edge of kept) {
    children[edge.parent].push(edge.child);
    parents[edge.child].push(edge.parent);
  }

  // --- 3. layering ----------------------------------------------------------
  /* Longest path from a root, which is what guarantees a node is drawn below
     EVERY one of its parents. Shortest path would tuck it under the most
     general one and let other edges run upward, which reads as a
     contradiction. */
  const depth = new Array<number>(count).fill(0);
  for (const i of byGenerality) {
    for (const c of children[i]) {
      if (depth[i] + 1 > depth[c]) depth[c] = depth[i] + 1;
    }
  }

  const attached = (i: number) => parents[i].length > 0 || children[i].length > 0;
  let maxDepth = -1;
  for (let i = 0; i < count; i++) {
    if (attached(i) && depth[i] > maxDepth) maxDepth = depth[i];
  }

  const rows: number[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (let i = 0; i < count; i++) if (attached(i)) rows[depth[i]].push(i);
  for (const row of rows) row.sort((a, b) => rank[a] - rank[b]);

  /* Tags that nothing contains and that contain nothing are not top-level
     concepts, they are loose ends -- on a real library, mostly years, which
     every file has and which therefore contain nothing in particular. Leaving
     them in row 0 would claim the library is organised around them, so they go
     below the base instead. They also have degree 0, which is what makes the
     existing Orphans toggle hide exactly this block.
     They are WRAPPED rather than laid in one row: there are often more loose
     tags than structured ones, and a single row of forty would be a ribbon
     four times wider than the hierarchy it is supposed to sit under. */
  const loose = [];
  for (let i = 0; i < count; i++) if (!attached(i)) loose.push(i);
  loose.sort((a, b) => rank[a] - rank[b]);

  const widest = Math.max(MIN_LOOSE_ROW, ...rows.map((row) => row.length));
  const looseRows = Math.ceil(loose.length / widest);
  const perRow = looseRows ? Math.ceil(loose.length / looseRows) : 0;
  const firstLooseRow = rows.length;
  for (let k = 0; k < looseRows; k++) {
    const row = loose.slice(k * perRow, (k + 1) * perRow);
    row.forEach((i) => { depth[i] = rows.length; });
    rows.push(row);
  }

  // --- 4. ordering: the barycentre heuristic -------------------------------
  const position = new Array<number>(count).fill(0);
  const reindex = () => rows.forEach((row) => row.forEach((i, k) => { position[i] = k; }));
  reindex();

  const sweep = (row: number[], neighbours: number[][]) => {
    const key = new Map<number, number>();
    row.forEach((i, k) => {
      const list = neighbours[i];
      if (!list.length) { key.set(i, k); return; }
      let sum = 0;
      for (const j of list) sum += position[j];
      key.set(i, sum / list.length);
    });
    // A node with no neighbour on the reference row keeps its place, so the
    // comparator falls back to the current order rather than to anything
    // derived from the data.
    row.sort((a, b) => (key.get(a)! - key.get(b)!) || position[a] - position[b]);
  };

  for (let pass = 0; pass < SWEEPS; pass++) {
    for (let d = 1; d < rows.length; d++) { sweep(rows[d], parents); reindex(); }
    for (let d = rows.length - 2; d >= 0; d--) { sweep(rows[d], children); reindex(); }
  }

  // --- 5. coordinates -------------------------------------------------------
  const x = new Array<number>(count).fill(0);
  const y = new Array<number>(count).fill(0);
  for (let i = 0; i < count; i++) y[i] = depth[i] * rowHeight;

  // Seed the apex evenly, then hang every row below off the one above it.
  spread(rows[0] ?? [], x, pitch);
  for (let d = 1; d < rows.length; d++) pull(rows[d], parents, x, pitch);

  /* Then alternate. Pulling children under parents alone leaves a parent
     stranded off-centre above its own subtree, which is the most obvious flaw
     in a naive layered drawing. */
  for (let pass = 0; pass < SWEEPS; pass++) {
    for (let d = rows.length - 2; d >= 0; d--) pull(rows[d], children, x, pitch);
    for (let d = 1; d < rows.length; d++) pull(rows[d], parents, x, pitch);
  }

  packComponents(rows.slice(0, firstLooseRow), parents, children, x, pitch);

  // The invariant the layers promise, restored after the packing above may
  // have moved a whole component past another one.
  for (const row of rows) row.sort((a, b) => x[a] - x[b]);

  const layers: PyramidLayer[] = rows
    .map((row, d) => {
      const isLoose = d >= firstLooseRow;
      const continues = isLoose && d > firstLooseRow;
      return {
        depth: d,
        nodes: row,
        y: d * rowHeight,
        unattached: isLoose && maxDepth >= 0,
        continues,
        groupSize: isLoose ? loose.length : row.length,
        label: continues ? '' : labelFor(d, firstLooseRow, maxDepth),
      };
    })
    .filter((layer) => layer.nodes.length > 0);

  return { depth, x, y, parents, children, edges: kept, layers, maxDepth };
}

function labelFor(depth: number, firstLooseRow: number, maxDepth: number): string {
  // Nothing contains anything: there is no hierarchy to caption, and calling
  // the only row "Broadest" would imply a level below it that does not exist.
  if (maxDepth < 0) return 'All tags';
  if (depth >= firstLooseRow) return 'Unattached';
  if (depth === 0) return 'Broadest';
  if (depth === maxDepth) return 'Most specific';
  return `Level ${depth + 1}`;
}

/* Slide each connected piece of the hierarchy up against the one before it.
 *
 * Barycentre positioning has nothing to say about two subtrees that share no
 * edge, so they end up wherever the seeding left them -- on a real library,
 * four screens apart with nothing in between. The gap looks like a bug, and it
 * hides the structure by making everything else small enough to fit beside it.
 *
 * Each piece is moved RIGIDLY, so the alignment of children under parents that
 * the previous passes worked for is exactly preserved; only the space between
 * pieces changes.
 */
function packComponents(
  rows: number[][],
  parents: number[][],
  children: number[][],
  x: number[],
  pitch: number,
): void {
  const nodes = rows.flat();
  if (nodes.length < 2) return;

  const component = new Map<number, number>();
  let count = 0;
  for (const start of nodes) {
    if (component.has(start)) continue;
    const queue = [start];
    component.set(start, count);
    while (queue.length) {
      const current = queue.pop()!;
      for (const next of [...parents[current], ...children[current]]) {
        if (!component.has(next)) { component.set(next, count); queue.push(next); }
      }
    }
    count++;
  }
  if (count < 2) return;

  const extents = Array.from({ length: count }, () => ({ min: Infinity, max: -Infinity }));
  for (const i of nodes) {
    const e = extents[component.get(i)!];
    if (x[i] < e.min) e.min = x[i];
    if (x[i] > e.max) e.max = x[i];
  }

  // Left to right in the order they already sit in, so packing tidies the
  // drawing rather than rearranging it.
  const order = extents.map((_, i) => i).sort((a, b) => extents[a].min - extents[b].min);
  const shift = new Array<number>(count).fill(0);
  const gap = pitch * 1.25;
  let cursor = 0;
  for (const c of order) {
    shift[c] = cursor - extents[c].min;
    cursor = extents[c].max + shift[c] + gap;
  }

  // Then put the packed block back on the axis, where the rows below it are.
  const centre = (cursor - gap) / 2;
  for (const i of nodes) x[i] += shift[component.get(i)!] - centre;
}

/** Evenly spaced about the origin. */
function spread(row: number[], x: number[], pitch: number): void {
  const left = -((row.length - 1) * pitch) / 2;
  row.forEach((i, k) => { x[i] = left + k * pitch; });
}

/* Move each node towards the average of its neighbours on the reference row,
 * then separate.
 *
 * The separation is a single left-to-right sweep -- take the wanted position,
 * or the last one plus a pitch, whichever is further right -- followed by a
 * shift that restores the row's average. Sweeping alone pushes every collision
 * rightwards, so a crowded row would drift off the axis and the pyramid would
 * lean. Restoring the mean is what keeps it upright.
 */
function pull(row: number[], neighbours: number[][], x: number[], pitch: number): void {
  if (!row.length) return;

  const wanted = row.map((i) => {
    const list = neighbours[i];
    if (!list.length) return x[i];
    let sum = 0;
    for (const j of list) sum += x[j];
    return sum / list.length;
  });

  let cursor = -Infinity;
  const placed = wanted.map((want) => {
    const at = Math.max(want, cursor + pitch);
    cursor = at;
    return at;
  });

  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const shift = mean(wanted) - mean(placed);
  row.forEach((i, k) => { x[i] = placed[k] + shift; });
}
