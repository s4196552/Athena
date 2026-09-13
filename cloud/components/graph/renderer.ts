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

  /* --- optional, and all four are what the pyramid needs to reuse this
     renderer rather than fork it. Unset, nothing below changes. --- */

  /** Explicit radii, overriding the degree curve. The pyramid sizes by file
   *  count: degree there is a property of the hierarchy, not of the tag. */
  radii?: number[];
  /** Horizontal strata drawn behind everything, one per level. */
  bands?: Band[];
  /** Draw edges as vertical curves. In a layered drawing this is not
   *  decoration: a straight line between two rows is ambiguous about which
   *  end it leaves from, and a curve that departs downward and arrives
   *  downward reads as descent at a glance. */
  curved?: boolean;
  /** Label every visible node rather than only the big ones. */
  labelAll?: boolean;
  /** World units between neighbours. Labels are suppressed when the zoom makes
   *  that gap too small on screen to fit one, which is cheaper and steadier
   *  than measuring every string. */
  labelGap?: number;
}

export interface Band {
  y: number;
  x0: number;
  x1: number;
  height: number;
  label: string;
  /** Drawn fainter -- the pyramid's row of unattached tags, which is context
   *  rather than a level of the hierarchy. */
  muted?: boolean;
}

export function radiusOf(degree: number): number {
  // Obsidian sizes by link count; degree here means "how much this file has in
  // common with the rest of the library", which is the right thing to enlarge.
  return Math.min(9, 2.2 + 1.7 * Math.sqrt(degree));
}

/** The radius a frame draws node `i` at, explicit if it was given one. */
export function radiusIn(
  frame: Pick<Frame, 'radii' | 'degree'>,
  i: number,
): number {
  return frame.radii ? frame.radii[i] : radiusOf(frame.degree[i]);
}

export function draw(ctx: CanvasRenderingContext2D, frame: Frame): void {
  const { positions, edges, degree, colors, transform, width, height, dpr } = frame;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  ctx.save();
  ctx.translate(transform.x, transform.y);
  ctx.scale(transform.k, transform.k);

  // --- strata, behind everything. Only the pyramid passes any.
  if (frame.bands?.length) {
    const pad = 34;
    for (const band of frame.bands) {
      ctx.fillStyle = band.muted ? 'rgba(120,138,160,0.035)' : 'rgba(120,138,160,0.062)';
      ctx.fillRect(
        band.x0 - pad, band.y - band.height / 2,
        (band.x1 - band.x0) + pad * 2, band.height,
      );
    }
    // Row captions sit outside the band to its left, at a constant on-screen
    // size, so they stay readable at any zoom without colliding with a node.
    ctx.fillStyle = 'rgba(150,168,190,0.65)';
    ctx.font = `${11 / transform.k}px -apple-system, "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const band of frame.bands) {
      if (band.label) ctx.fillText(band.label, band.x0 - pad - 12 / transform.k, band.y);
    }
  }

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

    const ax = positions[a * 2];
    const ay = positions[a * 2 + 1];
    const bx = positions[b * 2];
    const by = positions[b * 2 + 1];
    target.moveTo(ax, ay);
    if (frame.curved) {
      const bend = (by - ay) * 0.45;
      target.bezierCurveTo(ax, ay + bend, bx, by - bend, bx, by);
    } else {
      target.lineTo(bx, by);
    }
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
      const r = radiusIn(frame, i);
      ctx.moveTo(positions[i * 2] + r, positions[i * 2 + 1]);
      ctx.arc(positions[i * 2], positions[i * 2 + 1], r, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // --- hover ring
  if (frame.hover !== null) {
    const i = frame.hover;
    const r = radiusIn(frame, i) + 2.5;
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
  /* A label needs room on SCREEN, not in the world, so the test is the gap
     between neighbours after the zoom is applied. Without it the pyramid's
     rows overprint themselves the moment it is zoomed out to fit. */
  const roomToLabel = !frame.labelGap || frame.labelGap * transform.k >= 46;
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
      const bigEnough = frame.labelAll ? roomToLabel : zoomedIn && degree[i] >= 4;
      if (!isHover && !isMatch && !(frame.showLabels && bigEnough)) continue;

      const r = radiusIn(frame, i);
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
