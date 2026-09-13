'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomTransform } from 'd3-zoom';
import { quadtree, type Quadtree } from 'd3-quadtree';
import { draw, radiusOf, type Frame } from './renderer';
import type { SimParams } from './sim.worker';
import s from './graph.module.css';

export interface GraphData {
  count: number;
  labels: string[];
  degree: number[];
  edges: number[];
  weights: number[];
  x: number[];
  y: number[];
  colors: string[];
}

interface Props {
  data: GraphData;
  params: SimParams;
  search: string;
  showLabels: boolean;
  showOrphans: boolean;
  onHover?: (index: number | null) => void;
  onSelect?: (index: number) => void;
}

export function GraphCanvas({
  data, params, search, showLabels, showOrphans, onHover, onSelect,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const positionsRef = useRef<Float32Array>(new Float32Array(0));
  const transformRef = useRef<ZoomTransform>(zoomIdentity);
  const hoverRef = useRef<number | null>(null);
  const rafRef = useRef(0);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });

  /* The hit-test index lives in a ref, not in state, and is built from inside
     the worker's message handler rather than during render. Two reasons:
     positions change up to 60 times a second and must not each trigger a
     re-render, and a quadtree built during render would capture whatever
     positions happened to be current at that moment and then silently go
     stale. Null means "not built yet" and the caller falls back to a scan. */
  const hitTreeRef = useRef<Quadtree<number> | null>(null);

  // Adjacency, for hover highlighting.
  const adjacency = useMemo(() => {
    const adj: number[][] = Array.from({ length: data.count }, () => []);
    for (let e = 0; e < data.edges.length; e += 2) {
      const a = data.edges[e];
      const b = data.edges[e + 1];
      if (adj[a] && adj[b]) { adj[a].push(b); adj[b].push(a); }
    }
    return adj;
  }, [data.edges, data.count]);

  // Search dims non-matching nodes rather than removing them, so the shape of
  // the graph stays stable while you type.
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    const set = new Set<number>();
    for (let i = 0; i < data.labels.length; i++) {
      if (data.labels[i].toLowerCase().includes(q)) set.add(i);
    }
    return set;
  }, [search, data.labels]);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;

    const hover = hoverRef.current;
    const frame: Frame = {
      count: data.count,
      positions: positionsRef.current,
      edges: data.edges,
      degree: data.degree,
      colors: data.colors,
      labels: data.labels,
      transform: transformRef.current,
      width: sizeRef.current.w,
      height: sizeRef.current.h,
      dpr: sizeRef.current.dpr,
      hover,
      neighbours: hover !== null ? new Set(adjacency[hover] ?? []) : null,
      matches,
      showLabels,
      showOrphans,
    };
    draw(ctx, frame);
  }, [data, adjacency, matches, showLabels, showOrphans]);

  const schedule = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      render();
    });
  }, [render]);

  /* Size in CSS pixels, scale for devicePixelRatio. Skipping this gives a
     blurry graph on every high-DPI screen, which is every screen a demo gets
     shown on. DPR is capped at 2: a 3x Retina canvas quadruples fill cost for
     no visible gain. */
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      sizeRef.current = { w: rect.width, h: rect.height, dpr };
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      schedule();
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [schedule]);

  // The simulation, off the main thread.
  useEffect(() => {
    const seeded = new Float32Array(data.count * 2);
    for (let i = 0; i < data.count; i++) {
      seeded[i * 2] = data.x[i];
      seeded[i * 2 + 1] = data.y[i];
    }
    positionsRef.current = seeded;
    hitTreeRef.current = null;
    schedule();

    const worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    const count = data.count;
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'tick') {
        positionsRef.current = msg.positions as Float32Array;
        // Positions moved, so any existing index is stale.
        hitTreeRef.current = null;
        schedule();
      } else if (msg.type === 'settled') {
        // Built once, when the layout stops moving. ~0.2 ms for 1,500 inserts,
        // and it then serves every hover for free.
        const pos = positionsRef.current;
        hitTreeRef.current = quadtree<number>()
          .x((i) => pos[i * 2])
          .y((i) => pos[i * 2 + 1])
          .addAll(Array.from({ length: count }, (_, i) => i));
      }
    };

    worker.postMessage({
      type: 'start',
      count: data.count,
      degree: data.degree,
      edges: data.edges,
      weights: data.weights,
      x: data.x,
      y: data.y,
      params,
    });

    return () => {
      worker.postMessage({ type: 'stop' });
      worker.terminate();
      workerRef.current = null;
    };
    // `params` is deliberately not a dependency: moving a slider must nudge the
    // running simulation, not tear it down and restart from the seed layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, schedule]);

  useEffect(() => {
    workerRef.current?.postMessage({ type: 'params', params });
  }, [params]);

  useEffect(() => { schedule(); }, [data.colors, matches, showLabels, showOrphans, schedule]);

  const nodeAt = useCallback((clientX: number, clientY: number): number | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const t = transformRef.current;
    const inverted = t.invert([clientX - rect.left, clientY - rect.top]);
    const wx = inverted[0];
    const wy = inverted[1];
    const pos = positionsRef.current;
    const slack = 5 / t.k;

    const tree = hitTreeRef.current;
    if (tree) {
      const found = tree.find(wx, wy, 14 / t.k);
      if (found === undefined) return null;
      if (!showOrphans && data.degree[found] === 0) return null;
      const dx = pos[found * 2] - wx;
      const dy = pos[found * 2 + 1] - wy;
      return Math.hypot(dx, dy) <= radiusOf(data.degree[found]) + slack ? found : null;
    }

    // While the layout is still moving an index would be stale within a frame,
    // so scan. Correct, and only needed for the few seconds before it settles.
    let best: number | null = null;
    let bestDist = Infinity;
    for (let i = 0; i < data.count; i++) {
      if (!showOrphans && data.degree[i] === 0) continue;
      const dx = pos[i * 2] - wx;
      const dy = pos[i * 2 + 1] - wy;
      const d = Math.hypot(dx, dy);
      if (d < bestDist && d <= radiusOf(data.degree[i]) + slack) { best = i; bestDist = d; }
    }
    return best;
  }, [data.count, data.degree, showOrphans]);

  // Zoom and pan.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const behaviour = zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.12, 8])
      .on('zoom', (event) => {
        transformRef.current = event.transform;
        schedule();
      });

    const selection = select(canvas);
    selection.call(behaviour);

    /* The precomputed layout is in world units centred on the origin, so
       fitting it is arithmetic rather than a measure-then-adjust pass. */
    const rect = canvas.getBoundingClientRect();
    const extent = 26 * Math.sqrt(Math.max(data.count, 1)) * 1.15;
    const k = Math.min(rect.width, rect.height) / (extent * 2);
    selection.call(
      behaviour.transform,
      zoomIdentity.translate(rect.width / 2, rect.height / 2).scale(k),
    );

    return () => { selection.on('.zoom', null); };
  }, [data.count, schedule]);

  return (
    <div className={s.canvasWrap} ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className={s.canvas}
        tabIndex={0}
        aria-label={'Graph of ' + data.count + ' nodes. A text list of the most connected nodes follows.'}
        onMouseMove={(e) => {
          const found = nodeAt(e.clientX, e.clientY);
          if (found !== hoverRef.current) {
            hoverRef.current = found;
            onHover?.(found);
            schedule();
          }
        }}
        onMouseLeave={() => {
          if (hoverRef.current !== null) {
            hoverRef.current = null;
            onHover?.(null);
            schedule();
          }
        }}
        onClick={(e) => {
          const found = nodeAt(e.clientX, e.clientY);
          if (found !== null) onSelect?.(found);
        }}
      />
    </div>
  );
}
