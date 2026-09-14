'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { GraphCanvas, type GraphData } from '@/components/graph/GraphCanvas';
import { GraphAsk } from './GraphAsk';
import { FileDetail, type AlbumMembership } from '@/components/library/FileDetail';
import { openFile } from '../actions';
import type { FileView } from '@/lib/data/view';
import { colorAll, usedRules, type TagTableEntry } from '@/lib/graph/colors';
import { buildPyramid, type Pyramid } from '@/lib/graph/pyramid';
import {
  DEFAULT_NODE_COLOR, MIN_CONTAINMENT, PYRAMID_PITCH, PYRAMID_ROW,
} from '@/lib/graph/constants';
import type { Band } from '@/components/graph/renderer';
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

/* The pyramid is served by the same builder as the tag graph and arrives in
   the same shape -- only the edge budget differs -- so it is the tag payload
   under another name, and the difference lives where it belongs, in the
   layout. Keeping the two `mode` values in separate types is what lets every
   branch below narrow on it. */
interface PyramidPayload extends Omit<TagPayload, 'mode'> {
  mode: 'pyramid';
}

type Payload = FilePayload | TagPayload | PyramidPayload;

interface Props {
  ws: string;
  fileRules: ColorRule[];
  tagRules: ColorRule[];
  /** Whether this server has a speech key, so the ask panel can offer to read
   *  its answer aloud. Absent rather than failing when it does not. */
  speechReady: boolean;
  /** Whether this server has a model key, for the panel's "Ask the agent". */
  modelReady: boolean;
  /** Whether this viewer may correct a tag. The panel offers removal only when
   *  they can, rather than offering it and refusing. */
  canEdit: boolean;
  /** This workspace's albums, so the panel can file a dot into one. Handed
   *  down from the server rather than fetched with the file: there is no album
   *  rail on this page, so the list cannot change under it. */
  albums: AlbumMembership[];
}

type Mode = 'files' | 'tags' | 'pyramid';

/** Shape controls for the pyramid. Containment is the one that changes what
 *  the drawing CLAIMS; the other two only change how much room it takes. */
interface PyramidShape {
  containment: number;
  rowHeight: number;
  pitch: number;
}

const DEFAULT_SHAPE: PyramidShape = {
  containment: MIN_CONTAINMENT,
  rowHeight: PYRAMID_ROW,
  pitch: PYRAMID_PITCH,
};

export function GraphClient({
  ws, fileRules, tagRules, speechReady, modelReady, canEdit, albums,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  /* Seeded from the URL so a link can choose the drawing, not just the filter.
     The agent's "ask for a view" produces exactly that -- a question about how
     two topics overlap is answered by the TAG graph, and arriving at the file
     graph instead would silently be the wrong answer to it.

     Only the initial value: useState ignores later changes, which is what
     keeps the mode toggle working afterwards rather than being snapped back to
     the URL on every filter change. */
  const [mode, setMode] = useState<Mode>(() => {
    const asked = searchParams.get('mode');
    return asked === 'tags' || asked === 'pyramid' ? asked : 'files';
  });
  /* Result carries the request it answers. Deriving `loading` from whether the
     stored key still matches the current one avoids setting state synchronously
     at the top of the fetch effect, which React 19 flags because it triggers a
     cascading render on every filter change. */
  const [result, setResult] = useState<{ key: string; payload?: Payload; error?: string }>({ key: '' });
  const [search, setSearch] = useState('');
  /* Per mode, because the right default differs and switching should not
     silently undo a choice: sixty tag labels in rows are readable and are half
     the point of the pyramid, while two thousand file labels at once are a
     grey smear. */
  const [labelPrefs, setLabelPrefs] = useState<Record<Mode, boolean>>({
    files: false, tags: false, pyramid: true,
  });
  const [showOrphans, setShowOrphans] = useState(true);
  /* Two separate things, deliberately. Hovering a colour group asks "which of
     these are they" and is answered by dimming the rest; clicking one says
     "only these", and the rest leave the drawing. Held as the group's COLOUR
     because that is the only identity a drawn node carries -- see `groups`. */
  const [hoverGroup, setHoverGroup] = useState<string | null>(null);
  const [pickedGroup, setPickedGroup] = useState<string | null>(null);

  /* The dot being inspected. Held as id + name + (once it lands) the full
     record, so the panel can open on the click with a correct heading and fill
     in underneath. */
  const [opened, setOpened] = useState<{ id: string; name: string; file?: FileView } | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [params, setParams] = useState<SimParams>(DEFAULT_PARAMS);
  const [shape, setShape] = useState<PyramidShape>(DEFAULT_SHAPE);
  const [hover, setHover] = useState<number | null>(null);

  const showLabels = labelPrefs[mode];
  const setShowLabels = useCallback(
    (on: boolean) => setLabelPrefs((prefs) => ({ ...prefs, [mode]: on })),
    [mode],
  );

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

  const { data, tagTable, nodeTags, pyramid } = useMemo((): {
    data: GraphData | null;
    tagTable: TagTableEntry[];
    nodeTags: { tags: number[]; name?: string; path?: string; ext?: string; mediaType?: string }[];
    pyramid: Pyramid | null;
  } => {
    if (!payload) return { data: null, tagTable: [], nodeTags: [], pyramid: null };

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
        pyramid: null,
      };
    }

    // Tag mode. Each node IS a tag, so its own entry is its only tag -- which
    // makes a `kind:` rule colour it, exactly as the desktop app does.
    const table: TagTableEntry[] = payload.nodes.map((n) => ({
      kind: n.kind as TagKind, name: n.name,
    }));
    const nodeTags = payload.nodes.map((n, i) => ({ tags: [i], name: n.label }));

    if (payload.mode === 'pyramid') {
      const layout = buildPyramid(payload.nodes, payload.edges, shape);

      // Parent first, so the renderer's curves all depart downward.
      const edges: number[] = [];
      const weights: number[] = [];
      for (const e of layout.edges) {
        edges.push(e.parent, e.child);
        weights.push(Math.max(1, Math.round(e.containment * 255)));
      }
      const degree = payload.nodes.map(
        (_, i) => layout.parents[i].length + layout.children[i].length,
      );

      /* Sized by files, not by degree. In the file graph degree means "how
         much this has in common with everything else", which is worth
         enlarging; here it would only mean "how many rows this tag happens to
         touch", and the number a reader wants from the apex is how much of the
         library it covers. */
      const biggest = Math.max(1, ...payload.nodes.map((n) => n.n));
      const radii = payload.nodes.map((n) => 3.2 + 7.3 * Math.sqrt(n.n / biggest));

      return {
        data: {
          count: payload.nodes.length,
          labels: payload.nodes.map((n) => n.label),
          degree, edges, weights, x: layout.x, y: layout.y, colors: [], radii,
        },
        tagTable: table,
        nodeTags,
        pyramid: layout,
      };
    }

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
      nodeTags,
      pyramid: null,
    };
  }, [payload, shape]);

  /* One stratum per level, drawn behind the nodes. The row captions are the
     only thing that says which way is up, so they are part of the drawing
     rather than a legend somewhere else on the page. */
  const bands = useMemo((): Band[] | undefined => {
    if (!pyramid || !data) return undefined;
    const visible = pyramid.layers.filter((layer) => showOrphans || !layer.unattached);
    if (!visible.length) return undefined;

    /* Every stratum spans the WHOLE drawing rather than only its own nodes.
       Ragged bands read as blocks of unrelated width; equal ones read as
       levels, and they put the captions in a column instead of a staircase. */
    const xs = visible.flatMap((layer) => layer.nodes.map((i) => data.x[i]));
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);

    /* One band per GROUP, not per row: the unattached tags wrap over several
       rows and are one thing, so four separate stripes would say the opposite.
       The caption then centres on the block it names. */
    const out: Band[] = [];
    for (const layer of visible) {
      const previous = out[out.length - 1];
      if (layer.continues && previous) {
        const bottom = layer.y + shape.rowHeight * 0.31;
        const top = previous.y - previous.height / 2;
        previous.y = (top + bottom) / 2;
        previous.height = bottom - top;
        continue;
      }
      out.push({
        y: layer.y,
        x0,
        x1,
        height: shape.rowHeight * 0.62,
        label: `${layer.label} · ${layer.groupSize}`,
        muted: layer.unattached,
      });
    }
    return out;
  }, [pyramid, data, shape.rowHeight, showOrphans]);

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

  /* The legend, with the nodes each entry stands for.
   *
   * Keyed by COLOUR rather than by rule id, because colour is all a drawn node
   * carries: colorAll() resolves first-match-wins down to a hex string and
   * forgets which rule produced it. Two rules sharing one colour are therefore
   * one group's worth of nodes here -- which is also exactly what the drawing
   * shows, so the legend cannot promise a distinction the canvas can't make.
   */
  const groups = useMemo(() => {
    const members = new Map<string, number[]>();
    for (let i = 0; i < colors.length; i++) {
      /* Counted against what is actually drawn, so the number beside a key,
         the nodes it lights up and the caption's total are one figure rather
         than three. Toggling orphans therefore moves these counts, which is
         the point: they describe the picture, not the catalogue. */
      if (!showOrphans && data?.degree[i] === 0) continue;
      const list = members.get(colors[i]);
      if (list) list.push(i);
      else members.set(colors[i], [i]);
    }
    const out = legend.map((r) => ({
      id: r.id, color: r.color, label: r.label, nodes: members.get(r.color) ?? [],
    }));
    // "Other" is the leftover, so it is only a group when no rule has claimed
    // the neutral grey for itself.
    const other = members.get(DEFAULT_NODE_COLOR);
    if (other && !out.some((g) => g.color === DEFAULT_NODE_COLOR)) {
      out.push({ id: 'other', color: DEFAULT_NODE_COLOR, label: 'Other', nodes: other });
    }
    return out;
  }, [colors, legend, showOrphans, data]);

  /* Both selections are re-checked against the groups that exist right now
     rather than trusted from state. A rule can be disabled, recoloured or
     filtered down to nothing between one render and the next, and a stale
     pick would then hide the entire graph with no visible way back. */
  const picked = groups.some((g) => g.color === pickedGroup) ? pickedGroup : null;
  const hovered = groups.some((g) => g.color === hoverGroup) ? hoverGroup : null;
  const pickedLabel = groups.find((g) => g.color === picked)?.label;
  const drawnCount = groups.reduce((n, g) => n + g.nodes.length, 0);

  const nodesOf = useCallback((color: string | null) => {
    const group = color ? groups.find((g) => g.color === color) : undefined;
    return group ? new Set(group.nodes) : null;
  }, [groups]);

  const visible = useMemo(() => nodesOf(picked), [nodesOf, picked]);
  /* Hovering while a group is picked has nothing to say -- the others are not
     on screen to dim -- so the button's own hover state carries it instead. */
  const highlight = useMemo(
    () => (picked ? null : nodesOf(hovered)),
    [nodesOf, picked, hovered],
  );

  /* Clicking a FILE opens the same panel the library opens, here, over the
     drawing. It used to navigate to the library filtered by the file's name,
     which answered a question nobody asked -- you clicked one dot and were
     shown a list, on another page, having lost the cloud you were reading.
     A dot in a graph is a thing, and clicking a thing should tell you what it
     is.

     Clicking a TAG still adds it to the filter, unchanged. That is not an
     inconsistency: a tag node is not a thing you inspect, it is a way of
     narrowing what is drawn, and it is what turns the graph from a picture
     into a way of navigating. */
  const onSelect = useCallback((index: number) => {
    if (!payload) return;

    if (payload.mode !== 'files') {
      const node = payload.nodes[index];
      const qs = new URLSearchParams(filterQuery);
      const existing = qs.get(node.kind)?.split(',').filter(Boolean) ?? [];
      if (!existing.includes(node.name)) {
        qs.set(node.kind, [...existing, node.name].join(','));
        router.push(`/w/${ws}/graph?${qs}`);
      }
      return;
    }

    const id = payload.ids[index];
    if (!id) return;

    /* Opened optimistically with the name the drawing already holds, so the
       panel appears on the click rather than after a round trip. The rest
       arrives a moment later and replaces it. A spinner where the answer will
       be is worse than a heading that is already correct. */
    setOpened({ id, name: payload.labels[index] });
    setOpenError(null);

    openFile(ws, id)
      .then((result) => {
        // Ignore an answer for a dot that is no longer the open one: two quick
        // clicks must not end with the first file's panel winning.
        setOpened((current) => (current?.id === id && result.ok
          ? { id, name: result.file.name, file: result.file }
          : current));
        if (!result.ok) setOpenError(result.error);
      })
      .catch(() => setOpenError('That file could not be read.'));
  }, [payload, filterQuery, router, ws]);

  const hint = useMemo(() => {
    if (hover === null || !payload || !data) return '';

    /* The pyramid's tooltip answers the question the drawing raises -- why is
       this tag on THIS row -- by naming the relation and quoting the number it
       was derived from, so the claim stays checkable. */
    if (payload.mode === 'pyramid') {
      if (!pyramid) return '';
      const node = payload.nodes[hover];
      const above = pyramid.parents[hover]
        .map((i) => payload.nodes[i].label)
        .slice(0, 3);
      const below = pyramid.children[hover].length;
      const containment = pyramid.edges
        .filter((e) => e.child === hover)
        .sort((a, b) => b.containment - a.containment)[0];

      const parts = [`${node.label} — ${node.n.toLocaleString()} files`];
      if (above.length && containment) {
        parts.push(`${Math.round(containment.containment * 100)}% of them are also `
          + `${payload.nodes[containment.parent].label}`);
      } else if (!above.length && below) {
        parts.push('a top-level tag here');
      } else if (!above.length) {
        parts.push('nothing contains it and it contains nothing');
      }
      if (below) parts.push(`${below} narrower ${below === 1 ? 'tag' : 'tags'} below`);
      return parts.join(' · ');
    }

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
  }, [hover, payload, data, pyramid]);

  const caption = !payload
    ? 'Loading…'
    : payload.mode === 'pyramid'
      ? `${payload.nodes.length} tags in ${pyramid?.layers.length ?? 0} levels`
        + ` across ${payload.files.toLocaleString()} files`
      : payload.mode === 'tags'
        ? `${payload.nodes.length} tags across ${payload.files.toLocaleString()} files`
        : `${payload.ids.length.toLocaleString()} files, ${(payload.edges.length / 2).toLocaleString()} links`;

  return (
    <div className={s.page} id="main">
      <div className={s.head}>
        <div className={s.modes} role="group" aria-label="Graph mode">
          {(['files', 'tags', 'pyramid'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`${s.mode} ${mode === option ? s.modeActive : ''}`}
              onClick={() => setMode(option)}
              aria-pressed={mode === option}
              title={MODE_HELP[option]}
            >
              {MODE_LABEL[option]}
            </button>
          ))}
        </div>

        <p className={s.caption}>
          {caption}
          {payload?.label ? ` — ${payload.label}` : ''}
          {/* Without this the count above keeps claiming the whole library
              while most of it has left the screen. */}
          {picked && visible ? ` — showing ${pickedLabel} only, `
            + `${visible.size.toLocaleString()} of ${drawnCount.toLocaleString()}` : ''}
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
          {mode === 'pyramid' ? 'Unattached' : 'Orphans'}
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
            /* The pyramid's coordinates ARE the answer, so nothing is allowed
               to move them afterwards. */
            simulate={mode !== 'pyramid'}
            bands={bands}
            /* Room for the row captions, which hang off the left of the
               drawing and would otherwise be fitted straight off the canvas. */
            insetLeft={mode === 'pyramid' ? shape.pitch * 2.4 : 0}
            curved={mode === 'pyramid'}
            labelAll={mode === 'pyramid'}
            labelGap={mode === 'pyramid' ? shape.pitch : undefined}
            highlight={highlight}
            visible={visible}
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
          {/* First in the rail: a question is how you decide what to look at,
              and the controls below are how you look at it. Applying a plan
              sets the mode and the URL and nothing else -- the colour rules,
              sliders and labels are the reader's, not the agent's. */}
          <GraphAsk
            ws={ws}
            canSpeak={speechReady}
            onApply={(answer) => {
              setMode(answer.plan.mode);
              router.push(answer.href, { scroll: false });
            }}
          />

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
            <div className={s.sectHead}>
              <p className={s.sectLabel}>Colour groups</p>
              {picked && (
                <button type="button" className={s.clearKey} onClick={() => setPickedGroup(null)}>
                  Show all
                </button>
              )}
            </div>
            {/* Styled from aria-pressed rather than a parallel `on` class, so
                the state the screen reader is told and the state the eye is
                shown are the same fact. */}
            <div
              className={s.legend}
              role="group"
              aria-label="Colour groups"
              data-picked={picked ? 'true' : undefined}
            >
              {groups.map((g) => {
                const on = picked === g.color;
                return (
                  <button
                    key={g.id}
                    type="button"
                    className={s.key}
                    aria-pressed={on}
                    title={on
                      ? `Showing ${g.label} only — click again to bring the rest back`
                      : `Show only ${g.label}`}
                    onClick={() => setPickedGroup(on ? null : g.color)}
                    onPointerEnter={() => setHoverGroup(g.color)}
                    onPointerLeave={() => setHoverGroup(null)}
                    /* Focus and blur as well as the pointer: the highlight is
                       the only thing that says which group a button names, and
                       tabbing to it has to say it too. */
                    onFocus={() => setHoverGroup(g.color)}
                    onBlur={() => setHoverGroup(null)}
                  >
                    <i style={{ background: g.color }} />
                    <span className={s.keyLabel}>{g.label}</span>
                    <span className={s.keyCount}>{g.nodes.length.toLocaleString()}</span>
                  </button>
                );
              })}
            </div>
            <p style={{ marginTop: 10, fontSize: 12 }}>
              <a href={`/w/${ws}/settings/colors`}>Edit colours →</a>
            </p>
          </div>

          {mode === 'pyramid' ? (
            <>
              <div className={s.section}>
                <p className={s.sectLabel}>Hierarchy</p>
                <Slider
                  label="Containment" value={shape.containment} min={0.3} max={0.95} step={0.05}
                  onChange={(v) => setShape((p) => ({ ...p, containment: v }))}
                  format={(v) => `${Math.round(v * 100)}%`}
                />
                <p className={s.note}>
                  A tag sits under another when at least this much of it is also
                  tagged that way. Raise it for a taller, stricter hierarchy;
                  lower it to pull more tags into the structure.
                </p>
                <Slider
                  label="Level gap" value={shape.rowHeight} min={60} max={200} step={4}
                  onChange={(v) => setShape((p) => ({ ...p, rowHeight: v }))}
                />
                <Slider
                  label="Spacing" value={shape.pitch} min={60} max={240} step={4}
                  onChange={(v) => setShape((p) => ({ ...p, pitch: v }))}
                />
                <button
                  type="button"
                  className={s.mode}
                  style={{ border: '1px solid var(--line)', borderRadius: 8, marginTop: 4 }}
                  onClick={() => setShape(DEFAULT_SHAPE)}
                >
                  Reset shape
                </button>
              </div>

              {pyramid && pyramid.layers.length > 0 && (
                <div className={s.section}>
                  <p className={s.sectLabel}>Levels</p>
                  <ol className={s.levels}>
                    {pyramid.layers.filter((layer) => !layer.continues).map((layer) => (
                      <li key={layer.depth} className={layer.unattached ? s.levelLoose : undefined}>
                        <span>{layer.label}</span>
                        <span>{layer.groupSize}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </>
          ) : (
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
          )}
        </aside>
      </div>

      <p className={s.hint}>
        {hint || HINT[mode]}
      </p>

      {/* A canvas graph is invisible to a screen reader; this is the same
          information as focusable links. */}
      <ul className={s.srOnly}>
        {payload?.mode === 'files'
          ? payload.labels.slice(0, 20).map((label, i) => (
              <li key={payload.ids[i]}>{label}</li>
            ))
          : payload?.mode === 'tags'
            ? payload.nodes.slice(0, 20).map((n) => (
                <li key={n.tid}>{n.label}: {n.n} files</li>
              ))
            : payload && pyramid
              // Level by level, which is the structure a sighted reader gets
              // from the rows and would otherwise be lost entirely.
              ? pyramid.layers.map((layer) => (
                  <li key={layer.depth}>
                    {layer.label}: {layer.nodes.map((i) => payload.nodes[i].label).join(', ')}
                  </li>
                ))
              : null}
      </ul>

      {/* The panel is `position: fixed`, so it sits over the drawing without
          the graph having to give up any width -- which matters here more than
          in the library, because the canvas is the content. */}
      {opened?.file && (
        <FileDetail
          key={opened.id}
          ws={ws}
          file={opened.file}
          albums={albums}
          canEdit={canEdit}
          modelReady={modelReady}
          speechReady={speechReady}
          onClose={() => { setOpened(null); setOpenError(null); }}
        />
      )}

      {/* Between the click and the record landing, and when it does not.
          Announced, because the click that opened it was on a canvas and a
          screen reader has nothing else to notice. */}
      {opened && !opened.file && (
        <div className={s.filePending} role="status">
          {openError ? `${opened.name} — ${openError}` : `Opening ${opened.name}…`}
          <button type="button" onClick={() => { setOpened(null); setOpenError(null); }}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}

const MODE_LABEL: Record<Mode, string> = {
  files: 'Files',
  tags: 'Tags',
  pyramid: 'Pyramid',
};

const MODE_HELP: Record<Mode, string> = {
  files: 'Every file in the selection, linked by the tags they share.',
  tags: 'Tags linked by appearing on the same file.',
  pyramid: 'Tags stacked general to specific, by which ones contain which.',
};

const HINT: Record<Mode, string> = {
  files: 'Hover a file to see what it is tied to. Click to open it in the library.',
  tags: 'Click a tag to add it to the filter.',
  pyramid: 'General tags at the top, the ones they contain below. Click a tag to filter by it.',
};

function Slider({
  label, value, min, max, step, onChange, format,
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void;
  /** For values a bare number reads badly as -- 0.6 meaning "60% of them". */
  format?: (v: number) => string;
}) {
  return (
    <label className={s.slider}>
      <span className={s.sliderHead}>
        <span>{label}</span>
        <span>{format ? format(value) : value}</span>
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
