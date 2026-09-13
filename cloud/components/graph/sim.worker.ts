/// <reference lib="webworker" />
import {
  forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide, forceRadial,
  type SimulationNodeDatum,
} from 'd3-force';

/* The force simulation, off the main thread.
 *
 * Why a worker rather than the desktop app's approach: athena/web/static/app.js
 * runs an all-pairs loop, and its own comment says why that is fine there --
 * "sixty nodes means naive all-pairs repulsion is 1,770 comparisons a frame,
 * which is nothing". At 1,500 nodes the same loop is 1.1 MILLION comparisons a
 * frame, and it would run on the thread handling pan, zoom and hover.
 *
 * d3's forceManyBody uses a quadtree (Barnes-Hut), so it is O(n log n) -- about
 * 17k interactions a tick instead of 1.1M. Putting it in a worker keeps even
 * that off the interaction thread.
 *
 * Positions come back as a transferable Float32Array: zero-copy, ~12 KB a
 * frame at 1,500 nodes. Deliberately NOT a SharedArrayBuffer, which would
 * require COOP/COEP cross-origin isolation headers and complicate the deploy
 * for no gain at this size.
 */

interface Node extends SimulationNodeDatum {
  index: number;
  deg: number;
}

type StartMessage = {
  type: 'start';
  count: number;
  degree: number[];
  edges: number[];
  weights: number[];
  /** Precomputed coordinates. Seeding from them rather than at random is the
   *  whole point of building the layout offline: the first frame is already
   *  structured, so the sim settles instead of untangling. */
  x: number[];
  y: number[];
  /** Force knobs, matching the control sliders. */
  params: SimParams;
};

export interface SimParams {
  charge: number;
  linkDistance: number;
  linkStrength: number;
  center: number;
  orphanRing: number;
}

type Message =
  | StartMessage
  | { type: 'params'; params: SimParams }
  | { type: 'reheat'; alpha?: number }
  | { type: 'drag'; index: number; x: number; y: number }
  | { type: 'release'; index: number }
  | { type: 'stop' };

let sim: ReturnType<typeof forceSimulation<Node>> | null = null;
let nodes: Node[] = [];
let radius = 400;
let buffer: Float32Array | null = null;

function post() {
  if (!buffer || buffer.length < nodes.length * 2) {
    buffer = new Float32Array(nodes.length * 2);
  }
  const out = buffer;
  for (let i = 0; i < nodes.length; i++) {
    out[i * 2] = nodes[i].x ?? 0;
    out[i * 2 + 1] = nodes[i].y ?? 0;
  }
  // Transfer ownership, then take it back on the next message. The main
  // thread posts the same buffer straight back after drawing.
  const copy = out.slice();
  (self as unknown as Worker).postMessage(
    { type: 'tick', positions: copy, alpha: sim?.alpha() ?? 0 },
    [copy.buffer],
  );
}

function applyForces(params: SimParams) {
  if (!sim) return;
  sim
    .force('charge', forceManyBody<Node>()
      .strength((d) => -params.charge - 3 * Math.sqrt(d.deg))
      .theta(0.9)
      .distanceMax(radius * 0.75))
    .force('collide', forceCollide<Node>().radius((d) => 3 + Math.sqrt(d.deg)).iterations(1))
    .force('center', forceCenter(0, 0).strength(params.center))
    // Unconnected nodes drift outward and orbit -- the perimeter ring in an
    // Obsidian graph. An explicit weak radial force keeps them evenly spread
    // rather than stacked in one clump.
    .force('orphan', forceRadial<Node>(radius * 0.95, 0, 0)
      .strength((d) => (d.deg === 0 ? params.orphanRing : 0)));
}

self.onmessage = (event: MessageEvent<Message>) => {
  const msg = event.data;

  if (msg.type === 'start') {
    radius = 26 * Math.sqrt(Math.max(msg.count, 1));
    nodes = Array.from({ length: msg.count }, (_, i) => ({
      index: i,
      deg: msg.degree[i] ?? 0,
      x: msg.x[i] ?? 0,
      y: msg.y[i] ?? 0,
    }));

    const links = [];
    for (let e = 0; e < msg.weights.length; e++) {
      links.push({
        source: msg.edges[e * 2],
        target: msg.edges[e * 2 + 1],
        w: msg.weights[e] / 255,
      });
    }

    sim = forceSimulation(nodes)
      .force('link', forceLink(links)
        .id((d) => (d as Node).index)
        .distance(msg.params.linkDistance)
        // Pull on similarity, not on raw co-occurrence: the same reason the
        // tag graph pulls on `strength` rather than `weight`.
        .strength((l) => msg.params.linkStrength * (0.35 + (l as { w: number }).w)))
      /* A low starting alpha, because the seeded layout is already good. The
         client sim is here to RELAX an induced subgraph -- closing the gaps
         left by filtered-out nodes -- not to re-derive a layout that was
         computed properly offline. Starting hot visibly undoes that work. */
      .alpha(0.15)
      .alphaDecay(0.022)
      .alphaMin(0.004)
      .on('tick', post)
      // Cools on a schedule and STOPS, rather than jittering forever behind
      // whatever the user is trying to read.
      .on('end', () => (self as unknown as Worker).postMessage({ type: 'settled' }));

    applyForces(msg.params);
    return;
  }

  if (!sim) return;

  switch (msg.type) {
    case 'params':
      applyForces(msg.params);
      (sim.force('link') as ReturnType<typeof forceLink> | null)
        ?.distance(msg.params.linkDistance)
        .strength((l: unknown) => msg.params.linkStrength * (0.35 + (l as { w: number }).w));
      sim.alpha(0.3).restart();
      break;

    case 'reheat':
      sim.alpha(msg.alpha ?? 0.3).restart();
      break;

    case 'drag': {
      const n = nodes[msg.index];
      if (n) { n.fx = msg.x; n.fy = msg.y; }
      sim.alphaTarget(0.15).restart();
      break;
    }

    case 'release': {
      const n = nodes[msg.index];
      if (n) { n.fx = null; n.fy = null; }
      sim.alphaTarget(0);
      break;
    }

    case 'stop':
      sim.stop();
      break;
  }
};
