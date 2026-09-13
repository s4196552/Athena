import type { ZoomTransform } from 'd3-zoom';

/* The draw function.
 *
 * Pure: everything it needs arrives in `frame`. That is the seam a WebGL
 * renderer would replace -- one function, one signature -- if the node budget
 * ever outgrows Canvas 2D.
 *
 * Two things dominate the cost and both are handled here rather than left to
 * the caller:
 *
 *  - EDGES ARE BATCHED. 4,000 separate beginPath/stroke pairs is the usual
 *    mistake and costs roughly 5x what two batched Path2D strokes cost.
 *  - NODES ARE GROUPED BY COLOUR, one beginPath per colour, because changing
 *    fillStyle flushes the batch.
 */

export interface Frame {
  count: number;
  positions: Float32Array;
  edges: number[];
  degree: number[];
  colors: string[];
  labels: string[];
  transform: ZoomTransform;
  width: number;
  height: number;
  dpr: number;
  /** Node under the cursor, or null. */
  hover: number | null;
  /** 1-hop neighbours of `hover`. */
  neighbours: Set<number> | null;
  /** Indices matching the current search. Empty set means "no search". */
  matches: Set<number> | null;
  showLabels: boolean;
  showOrphans: boolean;
}

export function radiusOf(degree: number): number {
  // Obsidian sizes by link count; degree here means "how much this file has in
  // common with the rest of the library", which is the right thing to enlarge.
  return Math.min(9, 2.2 + 1.7 * Math.sqrt(degree));
}

export function draw(ctx: CanvasRenderingContext2D, frame: Frame): void {
  const { positions, edges, degree, colors, transform, width, height, dpr } = frame;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  ctx.save();
  ctx.translate(transform.x, transform.y);
  ctx.scale(transform.k, transform.k);

  const dimming = frame.hover !== null || (frame.matches?.size ?? 0) > 0;
  const lit = (i: number): boolean => {
    if (frame.hover !== null) return i === frame.hover || !!frame.neighbours?.has(i);
    if (frame.matches?.size) return frame.matches.has(i);
    return true;
  };

  // --- edges, in two batched passes
  const litPath = new Path2D();
  const dimPath = new Path2D();
  let hasLit = false;
  let hasDim = false;

  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e];
    const b = edges[e + 1];
    if (!frame.showOrphans && (degree[a] === 0 || degree[b] === 0)) continue;

    const target = !dimming || (lit(a) && lit(b)) ? litPath : dimPath;
    if (target === litPath) hasLit = true; else hasDim = true;

    target.moveTo(positions[a * 2], positions[a * 2 + 1]);
    target.lineTo(positions[b * 2], positions[b * 2 + 1]);
  }

  ctx.lineWidth = Math.max(0.35, 0.7 / transform.k);
  if (hasDim) {
    ctx.strokeStyle = 'rgba(120,138,160,0.05)';
    ctx.stroke(dimPath);
  }
  if (hasLit) {
    ctx.strokeStyle = dimming ? 'rgba(190,210,235,0.45)' : 'rgba(120,138,160,0.20)';
    ctx.stroke(litPath);
  }

  // --- nodes, grouped by colour so fillStyle changes once per group
  const groups = new Map<string, number[]>();
  for (let i = 0; i < frame.count; i++) {
    if (!frame.showOrphans && degree[i] === 0) continue;
    const key = `${colors[i]}|${dimming && !lit(i) ? 'd' : 'l'}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(i);
  }

  for (const [key, indices] of groups) {
    const [color, state] = key.split('|');
    ctx.globalAlpha = state === 'd' ? 0.18 : 1;
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const i of indices) {
      const r = radiusOf(degree[i]);
      ctx.moveTo(positions[i * 2] + r, positions[i * 2 + 1]);
      ctx.arc(positions[i * 2], positions[i * 2 + 1], r, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // --- hover ring
  if (frame.hover !== null) {
    const i = frame.hover;
    const r = radiusOf(degree[i]) + 2.5;
    ctx.strokeStyle = '#e6edf3';
    ctx.lineWidth = 1.6 / transform.k;
    ctx.beginPath();
    ctx.arc(positions[i * 2], positions[i * 2 + 1], r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // --- labels. Text is the dominant canvas cost, so they are strictly
  //     budgeted: only big nodes, only when zoomed in, only on hover, or only
  //     when they match a search.
  const zoomedIn = transform.k > 1.4;
  if (frame.showLabels || zoomedIn || frame.hover !== null || frame.matches?.size) {
    ctx.fillStyle = 'rgba(230,237,243,0.92)';
    ctx.font = `${Math.max(7, 11 / transform.k)}px -apple-system, "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    let budget = 140;
    for (let i = 0; i < frame.count && budget > 0; i++) {
      if (!frame.showOrphans && degree[i] === 0) continue;
      const isHover = i === frame.hover || frame.neighbours?.has(i);
      const isMatch = frame.matches?.has(i);
      const bigEnough = zoomedIn && degree[i] >= 4;
      if (!isHover && !isMatch && !(frame.showLabels && bigEnough)) continue;

      const r = radiusOf(degree[i]);
      const label = frame.labels[i];
      ctx.fillText(
        label.length > 28 ? label.slice(0, 27) + '…' : label,
        positions[i * 2],
        positions[i * 2 + 1] + r + 2,
      );
      budget--;
    }
  }

  ctx.restore();
}
