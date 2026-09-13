'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { GraphCanvas, type GraphData } from '@/components/graph/GraphCanvas';
import { colorAll, usedRules, type TagTableEntry } from '@/lib/graph/colors';
import { DEFAULT_NODE_COLOR } from '@/lib/graph/constants';
import type { ColorRule, TagKind } from '@/lib/data/types';
import type { SimParams } from '@/components/graph/sim.worker';
import s from '@/components/graph/graph.module.css';

/* Tuned against the seeded catalogue for a dense core with a legible rim.
 * Lower repulsion and firmer gravity keep the cloud compact; the orphan ring
 * is strong enough to separate unconnected files from the body without
 * flinging them off-screen. */
const DEFAULT_PARAMS: SimParams = {
  charge: 13,
  linkDistance: 30,
  linkStrength: 0.55,
  center: 0.10,
  orphanRing: 0.28,
};

interface FilePayload {
  mode: 'files';
  ids: string[];
  labels: string[];
  paths: string[];
  exts: string[];
  mediaTypes: string[];
  degree: number[];
  x: number[];
  y: number[];
  edges: number[];
  weights: number[];
  tagOffsets: number[];
  tagIndices: number[];
  tagTable: { kind: string; name: string; label: string }[];
  truncated: { shown: number; total: number } | null;
  files: number;
  label: string;
}

interface TagPayload {
  mode: 'tags';
  nodes: { tid: number; kind: string; label: string; name: string; n: number }[];
  edges: { source: number; target: number; weight: number; strength: number }[];
  files: number;
  label: string;
}

type Payload = FilePayload | TagPayload;

interface Props {
  ws: string;
  fileRules: ColorRule[];
  tagRules: ColorRule[];
}

export function GraphClient({ ws, fileRules, tagRules }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [mode, setMode] = useState<'files' | 'tags'>('files');
  /* Result carries the request it answers. Deriving `loading` from whether the
     stored key still matches the current one avoids setting state synchronously
     at the top of the fetch effect, which React 19 flags because it triggers a
     cascading render on every filter change. */
  const [result, setResult] = useState<{ key: string; payload?: Payload; error?: string }>({ key: '' });
  const [search, setSearch] = useState('');
  const [showLabels, setShowLabels] = useState(false);
  const [showOrphans, setShowOrphans] = useState(true);
  const [params, setParams] = useState<SimParams>(DEFAULT_PARAMS);
  const [hover, setHover] = useState<number | null>(null);

  const filterQuery = searchParams.toString();
  const requestKey = `${ws}|${mode}|${filterQuery}`;

  const payload = result.key === requestKey ? result.payload ?? null : null;
  const error = result.key === requestKey ? result.error ?? null : null;
  const loading = result.key !== requestKey;

  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams(filterQuery);
    qs.set('mode', mode);

    fetch(`/api/w/${ws}/graph?${qs}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: Payload) => { if (!cancelled) setResult({ key: requestKey, payload: data }); })
      .catch((e: Error) => { if (!cancelled) setResult({ key: requestKey, error: e.message }); });

    return () => { cancelled = true; };
  }, [ws, mode, filterQuery, requestKey]);

  // --- shape whichever payload arrived into what the canvas needs
  const rules = mode === 'files' ? fileRules : tagRules;

  const { data, tagTable, nodeTags } = useMemo((): {
    data: GraphData | null;
    tagTable: TagTableEntry[];
    nodeTags: { tags: number[]; name?: string; path?: string; ext?: string; mediaType?: string }[];
  } => {
    if (!payload) return { data: null, tagTable: [], nodeTags: [] };

    if (payload.mode === 'files') {
      const table: TagTableEntry[] = payload.tagTable.map((t) => ({
        kind: t.kind as TagKind, name: t.name,
      }));
      const nodes = payload.ids.map((_, i) => ({
        tags: payload.tagIndices.slice(payload.tagOffsets[i], payload.tagOffsets[i + 1]),
        name: payload.labels[i],
        path: payload.paths[i],
        ext: payload.exts[i],
        mediaType: payload.mediaTypes[i],
      }));
      return {
        data: {
          count: payload.ids.length,
          labels: payload.labels,
          degree: payload.degree,
          edges: payload.edges,
          weights: payload.weights,
          x: payload.x,
          y: payload.y,
          colors: [],
        },
        tagTable: table,
        nodeTags: nodes,
      };
    }

    // Tag mode. Each node IS a tag, so its own entry is its only tag -- which
    // makes a `kind:` rule colour it, exactly as the desktop app does.
    const table: TagTableEntry[] = payload.nodes.map((n) => ({
      kind: n.kind as TagKind, name: n.name,
    }));
    const index = new Map(payload.nodes.map((n, i) => [n.tid, i]));
    const edges: number[] = [];
    const weights: number[] = [];
    for (const e of payload.edges) {
      const a = index.get(e.source);
      const b = index.get(e.target);
      if (a === undefined || b === undefined) continue;
      edges.push(a, b);
      // The layout pulls on `strength`, not `weight`: ranking by raw count
      // makes every strong edge "2024 - something", a base rate rather than a
      // relationship.
      weights.push(Math.max(1, Math.round(e.strength * 255)));
    }
    const degree = new Array(payload.nodes.length).fill(0);
    for (let i = 0; i < edges.length; i += 2) { degree[edges[i]]++; degree[edges[i + 1]]++; }

    // Tag graphs have no precomputed layout (they are per-selection), so seed
    // on a circle: the first frame already has structure and the sim is not
    // untangling a knot.
    const r = 26 * Math.sqrt(Math.max(payload.nodes.length, 1));
    const x = payload.nodes.map((_, i) => Math.cos((i / payload.nodes.length) * Math.PI * 2) * r * 0.6);
    const y = payload.nodes.map((_, i) => Math.sin((i / payload.nodes.length) * Math.PI * 2) * r * 0.6);

    return {
      data: {
        count: payload.nodes.length,
        labels: payload.nodes.map((n) => n.label),
        degree, edges, weights, x, y, colors: [],
      },
      tagTable: table,
      nodeTags: payload.nodes.map((n, i) => ({ tags: [i], name: n.label })),
    };
  }, [payload]);

  /* Colours are resolved on the client from the CSR tag matrix, so editing a
     rule recolours every node in under a millisecond with no refetch. */
  const colors = useMemo(
    () => colorAll(nodeTags, rules, tagTable),
    [nodeTags, rules, tagTable],
  );

  const coloured = useMemo(
    () => (data ? { ...data, colors } : null),
    [data, colors],
  );

  const legend = useMemo(() => usedRules(colors, rules), [colors, rules]);

  const onSelect = useCallback((index: number) => {
    if (!payload) return;
    if (payload.mode === 'tags') {
      // Clicking a tag adds it to the filter. That is what turns the graph
      // from a picture into a way of navigating.
      const node = payload.nodes[index];
      const qs = new URLSearchParams(filterQuery);
      const existing = qs.get(node.kind)?.split(',').filter(Boolean) ?? [];
      if (!existing.includes(node.name)) {
        qs.set(node.kind, [...existing, node.name].join(','));
        router.push(`/w/${ws}/graph?${qs}`);
      }
    } else {
      router.push(`/w/${ws}/library?q=${encodeURIComponent(payload.labels[index])}`);
    }
  }, [payload, filterQuery, router, ws]);

  const hint = useMemo(() => {
    if (hover === null || !payload || !data) return '';
    if (payload.mode === 'tags') {
      const node = payload.nodes[hover];
      const linked = payload.edges
        .filter((e) => e.source === node.tid || e.target === node.tid)
        .sort((a, b) => b.strength - a.strength)
        .slice(0, 3)
        .map((e) => {
          const otherTid = e.source === node.tid ? e.target : e.source;
          return payload.nodes.find((n) => n.tid === otherTid)?.label;
        })
        .filter(Boolean);
      return `${node.label} — ${node.n.toLocaleString()} files`
        + (linked.length ? `. Mostly alongside ${linked.join(', ')}.` : '.');
    }
    const deg = data.degree[hover];
    return `${payload.labels[hover]} — ${payload.paths[hover]} · ${deg === 0 ? 'no shared tags' : deg + ' connections'}`;
  }, [hover, payload, data]);

  const caption = !payload
    ? 'Loading…'
    : payload.mode === 'tags'
      ? `${payload.nodes.length} tags across ${payload.files.toLocaleString()} files`
      : `${payload.ids.length.toLocaleString()} files, ${(payload.edges.length / 2).toLocaleString()} links`;

  return (
    <div className={s.page}>
      <div className={s.head}>
        <div className={s.modes} role="group" aria-label="Graph mode">
          <button
            type="button"
            className={`${s.mode} ${mode === 'files' ? s.modeActive : ''}`}
            onClick={() => setMode('files')}
            aria-pressed={mode === 'files'}
          >
            Files
          </button>
          <button
            type="button"
            className={`${s.mode} ${mode === 'tags' ? s.modeActive : ''}`}
            onClick={() => setMode('tags')}
            aria-pressed={mode === 'tags'}
          >
            Tags
          </button>
        </div>

        <p className={s.caption}>
          {caption}
          {payload?.label ? ` — ${payload.label}` : ''}
        </p>

        <div className={s.spacer} />

        <input
          className={s.search}
          type="search"
          placeholder="Search nodes…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search nodes"
        />
        <label className={s.toggle}>
          <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
          Labels
        </label>
        <label className={s.toggle}>
          <input type="checkbox" checked={showOrphans} onChange={(e) => setShowOrphans(e.target.checked)} />
          Orphans
        </label>
      </div>

      <div className={s.main}>
        {coloured && coloured.count > 0 ? (
          <GraphCanvas
            data={coloured}
            params={params}
            search={search}
            showLabels={showLabels}
            showOrphans={showOrphans}
            onHover={setHover}
            onSelect={onSelect}
          />
        ) : (
          <div className={s.canvasWrap}>
            <p className={s.empty}>
              {loading ? 'Building the graph…'
                : error ? `Could not load the graph (${error}).`
                : 'Nothing to draw. Widen the filter.'}
            </p>
          </div>
        )}

        <aside className={s.side}>
          {payload && 'truncated' in payload && payload.truncated && (
            <div className={s.section}>
              <p className={s.banner}>
                Showing the {payload.truncated.shown.toLocaleString()} most connected
                of {payload.truncated.total.toLocaleString()} files. Narrow the
                filter, or switch to Tags.
              </p>
            </div>
          )}

          <div className={s.section}>
            <p className={s.sectLabel}>Colour groups</p>
            <div className={s.legend}>
              {legend.map((r) => (
                <span key={r.id} className={s.key}>
                  <i style={{ background: r.color }} />
                  {r.label}
                </span>
              ))}
              {colors.includes(DEFAULT_NODE_COLOR) && (
                <span className={s.key}>
                  <i style={{ background: DEFAULT_NODE_COLOR }} />
                  Other
                </span>
              )}
            </div>
            <p style={{ marginTop: 10, fontSize: 12 }}>
              <a href={`/w/${ws}/settings/colors`}>Edit colours →</a>
            </p>
          </div>

          <div className={s.section}>
            <p className={s.sectLabel}>Forces</p>
            <Slider label="Repel" value={params.charge} min={4} max={80} step={1}
              onChange={(v) => setParams((p) => ({ ...p, charge: v }))} />
            <Slider label="Link distance" value={params.linkDistance} min={10} max={120} step={1}
              onChange={(v) => setParams((p) => ({ ...p, linkDistance: v }))} />
            <Slider label="Link force" value={params.linkStrength} min={0} max={1.5} step={0.05}
              onChange={(v) => setParams((p) => ({ ...p, linkStrength: v }))} />
            <Slider label="Centre" value={params.center} min={0} max={0.4} step={0.01}
              onChange={(v) => setParams((p) => ({ ...p, center: v }))} />
            <button
              type="button"
              className={s.mode}
              style={{ border: '1px solid var(--line)', borderRadius: 8, marginTop: 4 }}
              onClick={() => setParams(DEFAULT_PARAMS)}
            >
              Reset forces
            </button>
          </div>
        </aside>
      </div>

      <p className={s.hint}>
        {hint || (mode === 'tags'
          ? 'Click a tag to add it to the filter.'
          : 'Hover a file to see what it is tied to. Click to open it in the library.')}
      </p>

      {/* A canvas graph is invisible to a screen reader; this is the same
          information as focusable links. */}
      <ul className={s.srOnly}>
        {payload?.mode === 'tags'
          ? payload.nodes.slice(0, 20).map((n) => (
              <li key={n.tid}>{n.label}: {n.n} files</li>
            ))
          : payload?.labels.slice(0, 20).map((label, i) => (
              <li key={payload.ids[i]}>{label}</li>
            ))}
      </ul>
    </div>
  );
}

function Slider({
  label, value, min, max, step, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className={s.slider}>
      <span className={s.sliderHead}>
        <span>{label}</span>
        <span>{value}</span>
      </span>
      <input
        className={s.range}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
