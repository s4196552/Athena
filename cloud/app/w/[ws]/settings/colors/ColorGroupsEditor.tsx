'use client';

import { useMemo, useState } from 'react';
import { describeQuery, parseQuery, resolveColor, type TagTableEntry } from '@/lib/graph/colors';
import { DEFAULT_NODE_COLOR } from '@/lib/graph/constants';
import { useStoredRules } from '@/lib/graph/useStoredRules';
import type { ColorRule, GraphMode, TagKind } from '@/lib/data/types';
import s from './colors.module.css';
import { formatNumber } from '@/lib/format';

const PALETTE = [
  '#ffc861', '#b48cff', '#7ee0a3', '#5aa9ff', '#ff8fc2', '#ff9f5a',
  '#56d3c8', '#ff6f6f', '#d9d15e', '#8fb6c9', '#e35d8a', '#b9e06a',
  '#6fd0ff', '#cfa0ff', '#9fd0c0', '#7d8b9c',
];

interface PreviewNode {
  tags: number[];
  name: string;
  path: string;
  ext: string;
  mediaType: string;
}

interface Props {
  ws: string;
  mode: GraphMode;
  initial: ColorRule[];
  tagTable: TagTableEntry[];
  preview: PreviewNode[];
  /** Tag suggestions for the shorthand input. */
  suggestions: string[];
}

const storageKey = (ws: string, mode: GraphMode) => `athena:cg:${ws}:${mode}`;

export function ColorGroupsEditor({ ws, mode, initial, tagTable, preview, suggestions }: Props) {
  const [draft, setDraft] = useState('');

  /* Edits live in this viewer's browser: the catalogue ships as a committed
     file and Vercel's filesystem is read-only at runtime, so there is nowhere
     on the server to save a palette. Said plainly in the UI below, rather than
     offering a save button that quietly loses work. */
  const { rules, dirty, save: persist, reset } = useStoredRules(
    storageKey(ws, mode),
    initial,
  );

  const move = (index: number, delta: number) => {
    const next = [...rules];
    const to = index + delta;
    if (to < 0 || to >= next.length) return;
    [next[index], next[to]] = [next[to], next[index]];
    persist(next);
  };

  const add = () => {
    const query = parseQuery(draft);
    if (!query) return;
    persist([
      ...rules,
      {
        id: `r_${Date.now().toString(36)}`,
        label: describeQuery(query),
        color: PALETTE[rules.length % PALETTE.length],
        query,
        enabled: true,
      },
    ]);
    setDraft('');
  };

  // Recolouring is pure arithmetic over the tag matrix, so the preview updates
  // live while the colour picker is open. Nothing refetches.
  const colors = useMemo(
    () => preview.map((n) => resolveColor(n, rules, tagTable)),
    [preview, rules, tagTable],
  );

  const counts = useMemo(() => {
    const tally = new Map<string, number>();
    for (const c of colors) tally.set(c, (tally.get(c) ?? 0) + 1);
    return tally;
  }, [colors]);

  return (
    <div className={s.editor}>
      <div className={s.rules}>
        <div className={s.head}>
          <h2 className={s.title}>Colour groups</h2>
          {dirty && <button type="button" className={s.reset} onClick={reset}>Reset to default</button>}
        </div>

        <p className={s.explain}>
          Rules are checked <strong>top to bottom, first match wins</strong>. The
          order is the rule — drag a group above another to give it priority.
          Anything matching nothing takes the neutral grey.
        </p>

        <ol className={s.list}>
          {rules.map((rule, i) => (
            <li key={rule.id} className={`${s.rule} ${rule.enabled ? '' : s.ruleOff}`}>
              <span className={s.rank}>{i + 1}</span>

              <input
                className={s.swatch}
                type="color"
                value={rule.color}
                aria-label={`Colour for ${rule.label}`}
                onChange={(e) => {
                  const next = [...rules];
                  next[i] = { ...rule, color: e.target.value };
                  persist(next);
                }}
              />

              <span className={s.ruleBody}>
                <input
                  className={s.ruleLabel}
                  value={rule.label}
                  aria-label="Group name"
                  onChange={(e) => {
                    const next = [...rules];
                    next[i] = { ...rule, label: e.target.value };
                    persist(next);
                  }}
                />
                <code className={s.ruleQuery}>{describeQuery(rule.query)}</code>
              </span>

              <span className={s.ruleCount}>
                {(counts.get(rule.color) ?? formatNumber(0))}
              </span>

              <span className={s.ruleActions}>
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === rules.length - 1} aria-label="Move down">↓</button>
                <button
                  type="button"
                  onClick={() => {
                    const next = [...rules];
                    next[i] = { ...rule, enabled: !rule.enabled };
                    persist(next);
                  }}
                  aria-label={rule.enabled ? 'Disable' : 'Enable'}
                >
                  {rule.enabled ? '◉' : '○'}
                </button>
                <button
                  type="button"
                  onClick={() => persist(rules.filter((r) => r.id !== rule.id))}
                  aria-label="Delete"
                >
                  ×
                </button>
              </span>
            </li>
          ))}
        </ol>

        <div className={s.add}>
          <input
            className={s.addInput}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            placeholder="topic:finance, path:Documents/, ext:pdf, doctype:*"
            list="colour-suggestions"
            aria-label="New colour group"
          />
          <datalist id="colour-suggestions">
            {suggestions.map((x) => <option key={x} value={x} />)}
          </datalist>
          <button type="button" className={s.addBtn} onClick={add} disabled={!parseQuery(draft)}>
            Add group
          </button>
        </div>

        <p className={s.note}>
          Changes are kept in this browser only. The catalogue ships as a
          read-only file and Vercel&rsquo;s filesystem is read-only at runtime,
          so there is nowhere on the server to save them — rather than a save
          button that quietly loses your work.
        </p>
      </div>

      <div className={s.previewPane}>
        <h2 className={s.title}>Preview</h2>
        <p className={s.explain}>
          {formatNumber(preview.length)} files from this workspace, coloured by
          the rules as they stand.
        </p>
        <div className={s.swatchGrid} aria-hidden="true">
          {colors.map((c, i) => (
            <span key={i} className={s.dot} style={{ background: c }} title={preview[i].name} />
          ))}
        </div>
        <p className={s.legendRow}>
          <span className={s.dot} style={{ background: DEFAULT_NODE_COLOR }} />
          Unmatched: {(counts.get(DEFAULT_NODE_COLOR) ?? formatNumber(0))}
        </p>
      </div>
    </div>
  );
}

export type { TagKind };
