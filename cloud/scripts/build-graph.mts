/* Precomputes the file-level graph for each seeded library: k-NN edges AND a
 * settled force layout, both written into graph.json.
 *
 * Shipping a *layout* rather than merely a graph is the highest-leverage
 * decision in the design. The catalogue is static, so every expensive step can
 * run once here instead of on every page load:
 *
 *   - the first paint is already structured, with no four-second untangling
 *     animation while the user waits to see their library;
 *   - the client-side simulation becomes optional rather than load-bearing,
 *     needed only for filtered subgraphs and dragging;
 *   - an O(n^2)-shaped problem never reaches the browser at all.
 *
 * Run after generate-seed.mts (`npm run seed` does both).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide, forceRadial,
  type SimulationNodeDatum,
} from 'd3-force';

const here = dirname(fileURLToPath(import.meta.url));
const SEED = join(here, '..', 'data', 'seed');

// ---------------------------------------------------------------------------
//  Edge construction
// ---------------------------------------------------------------------------

/* An edge means "these two files are about the same thing". Applied naively --
 * "they share a tag" -- that is a hairball: a single `2024` tag on 1,900 files
 * yields 1.8 million pairs by itself and says nothing, because nearly every
 * file has a year.
 *
 * The Python engine already worked out the concept for the tag graph: ranking
 * by raw count makes every top edge "2024 -- something", which is a base rate,
 * not a relationship (athena/web/queries.py:435-441). The same insight applied
 * structurally here gives four defences against the hairball:
 *
 *   1. SPECIFIC_DF -- tags on more than a quarter of the library are excluded
 *      from the similarity vector entirely. They carry no information about
 *      *which* two files belong together.
 *   2. MIN_SHARED  -- one tag in common is a coincidence.
 *   3. MIN_SIM     -- an IDF-weighted cosine floor.
 *   4. TOP_K       -- each file keeps only its k strongest neighbours.
 *
 * The result is average degree ~5 rather than ~40, which is the difference
 * between a picture with clusters and an illegible fog.
 */
const SPECIFIC_DF = 0.25;
const MIN_SHARED = 2;
const MIN_SIM = 0.35;
const TOP_K = 5;

interface TagRow { id: number; kind: string; name: string; fileCount: number; idf: number }
interface FileRow { id: string; tags: number[] }

function buildEdges(files: FileRow[], tags: TagRow[]) {
  const n = files.length;
  const dfCap = SPECIFIC_DF * n;

  const idf = new Map<number, number>();
  const specific = new Set<number>();
  for (const t of tags) {
    idf.set(t.id, t.idf);
    if (t.fileCount > 0 && t.fileCount <= dfCap) specific.add(t.id);
  }

  // Similarity vectors over specific tags only.
  const vec: number[][] = new Array(n);
  const norm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = files[i].tags.filter((t) => specific.has(t));
    vec[i] = v;
    let sq = 0;
    for (const t of v) { const w = idf.get(t)!; sq += w * w; }
    norm[i] = Math.sqrt(sq);
  }

  // Inverted index. Candidate generation walks posting lists rather than all
  // pairs -- at 6,120 files that is the difference between ~3 seconds and
  // ~19 million comparisons.
  const postings = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    for (const t of vec[i]) {
      let p = postings.get(t);
      if (!p) postings.set(t, (p = []));
      p.push(i);
    }
  }

  type Cand = { shared: number; dot: number };
  const pairs = new Map<string, number>();   // "i:j" (i<j) -> similarity
  const acc = new Map<number, Cand>();

  for (let i = 0; i < n; i++) {
    if (norm[i] === 0) continue;
    acc.clear();

    for (const t of vec[i]) {
      const w = idf.get(t)!;
      const w2 = w * w;
      for (const j of postings.get(t)!) {
        if (j === i) continue;
        let c = acc.get(j);
        if (!c) acc.set(j, (c = { shared: 0, dot: 0 }));
        c.shared++;
        c.dot += w2;
      }
    }

    // Keep this file's strongest TOP_K neighbours.
    const best: { j: number; sim: number }[] = [];
    for (const [j, c] of acc) {
      if (c.shared < MIN_SHARED || norm[j] === 0) continue;
      const sim = c.dot / (norm[i] * norm[j]);
      if (sim < MIN_SIM) continue;
      best.push({ j, sim });
    }
    best.sort((a, b) => b.sim - a.sim);

    for (const { j, sim } of best.slice(0, TOP_K)) {
      // Union of both files' top-k lists, so an edge survives if either end
      // considers the other one of its nearest neighbours.
      const key = i < j ? `${i}:${j}` : `${j}:${i}`;
      const prev = pairs.get(key);
      if (prev === undefined || sim > prev) pairs.set(key, sim);
    }
  }

  const edges: number[] = [];
  const weights: number[] = [];
  const degree = new Uint16Array(n);
  for (const [key, sim] of pairs) {
    const [a, b] = key.split(':').map(Number);
    edges.push(a, b);
    weights.push(Math.max(1, Math.min(255, Math.round(sim * 255))));
    degree[a]++;
    degree[b]++;
  }

  return { edges, weights, degree };
}

// ---------------------------------------------------------------------------
//  Layout
// ---------------------------------------------------------------------------

interface Node extends SimulationNodeDatum { index: number; deg: number }

function layout(n: number, edges: number[], weights: number[], degree: Uint16Array) {
  const nodes: Node[] = Array.from({ length: n }, (_, i) => ({ index: i, deg: degree[i] }));
  const links = [];
  for (let e = 0; e < weights.length; e++) {
    links.push({
      source: edges[e * 2],
      target: edges[e * 2 + 1],
      w: weights[e] / 255,
    });
  }

  // Radius scales with sqrt(n) so density stays comparable across libraries of
  // very different sizes.
  const R = 26 * Math.sqrt(n);

  const sim = forceSimulation(nodes)
    .force('charge', forceManyBody<Node>()
      // Barnes-Hut via d3-quadtree: O(n log n) instead of the O(n^2) the
      // desktop app's hand-written loop uses. That loop is correct for its
      // stated 60 nodes (1,770 pairs a frame); here it would be 18.7 million.
      .strength((d) => -18 - 3 * Math.sqrt(d.deg))
      .theta(0.9)
      .distanceMax(R * 0.75))
    .force('link', forceLink(links)
      .id((d) => (d as Node).index)
      .distance(34)
      // Pull on similarity, not on raw co-occurrence -- the same reason the
      // tag graph pulls on `strength` rather than `weight`.
      .strength((l) => 0.22 + 0.55 * (l as { w: number }).w))
    .force('collide', forceCollide<Node>().radius((d) => 3 + Math.sqrt(d.deg)).iterations(1))
    .force('center', forceCenter(0, 0))
    // Unconnected files drift to the perimeter and orbit. This is the ring in
    // an Obsidian graph; giving it an explicit weak radial force keeps those
    // nodes evenly spread instead of stacked in one clump.
    .force('orphan', forceRadial<Node>(R * 0.95, 0, 0).strength((d) => (d.deg === 0 ? 0.16 : 0)))
    .stop();

  const ticks = 400;
  for (let i = 0; i < ticks; i++) sim.tick();

  return nodes;
}

// ---------------------------------------------------------------------------
//  Run
// ---------------------------------------------------------------------------

const tenancy = JSON.parse(readFileSync(join(SEED, 'tenancy.json'), 'utf8'));

for (const lib of tenancy.libraries as { slug: string }[]) {
  const dir = join(SEED, 'libraries', lib.slug);
  const files: FileRow[] = JSON.parse(readFileSync(join(dir, 'files.json'), 'utf8'));
  const tags: TagRow[] = JSON.parse(readFileSync(join(dir, 'tags.json'), 'utf8'));

  const t0 = Date.now();
  const { edges, weights, degree } = buildEdges(files, tags);
  const t1 = Date.now();
  const nodes = layout(files.length, edges, weights, degree);
  const t2 = Date.now();

  const orphans = [...degree].filter((d) => d === 0).length;
  const avgDeg = (2 * weights.length) / files.length;

  writeFileSync(join(dir, 'graph.json'), JSON.stringify({
    ids: files.map((f) => f.id),
    degree: [...degree],
    x: nodes.map((d) => Math.round(d.x ?? 0)),
    y: nodes.map((d) => Math.round(d.y ?? 0)),
    edges,
    weights,
  }));

  console.log(
    `  ${lib.slug.padEnd(24)} ${String(files.length).padStart(5)} nodes, ` +
    `${String(weights.length).padStart(6)} edges, avg degree ${avgDeg.toFixed(1)}, ` +
    `${orphans} orphans  (edges ${t1 - t0}ms, layout ${t2 - t1}ms)`,
  );
}
