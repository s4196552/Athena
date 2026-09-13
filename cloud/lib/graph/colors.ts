import type { ColorRule, ColorQuery, TagKind } from '../data/types';
import { DEFAULT_NODE_COLOR } from './constants';

/* Tag -> colour.
 *
 * Modelled on Obsidian's graph "groups": an ORDERED list of rules, first
 * enabled match wins. The ordering IS the precedence rule, which is why the
 * editor is drag-sortable rather than documented -- you can see which rule
 * wins by looking at the list.
 *
 * Evaluation is pure client-side arithmetic over a compact tag matrix, so
 * editing a rule recolours every node in well under a millisecond, live, while
 * the colour picker is still open. Nothing refetches.
 */

/** The minimum a node needs to expose for rules to be evaluated against it. */
export interface ColorableNode {
  /** Indices into the payload's tag table. */
  tags: number[];
  name?: string;
  path?: string;
  ext?: string;
  mediaType?: string;
}

export interface TagTableEntry {
  kind: TagKind;
  name: string;
}

function matches(
  query: ColorQuery,
  node: ColorableNode,
  tagTable: TagTableEntry[],
): boolean {
  switch (query.type) {
    case 'tag':
      return node.tags.some((i) => {
        const t = tagTable[i];
        return t && t.kind === query.kind && t.name === query.name;
      });
    case 'kind':
      return node.tags.some((i) => tagTable[i]?.kind === query.kind);
    case 'path':
      return (node.path ?? '').startsWith(query.prefix);
    case 'media':
      return node.mediaType === query.mediaType;
    case 'ext':
      return (node.ext ?? '').toLowerCase() === query.ext.toLowerCase();
    case 'text':
      return (node.name ?? '').toLowerCase().includes(query.q.toLowerCase());
    case 'untagged':
      return node.tags.length === 0;
    default:
      return false;
  }
}

/** First enabled match wins; unmatched nodes take the neutral grey. */
export function resolveColor(
  node: ColorableNode,
  rules: ColorRule[],
  tagTable: TagTableEntry[],
): string {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (matches(rule.query, node, tagTable)) return rule.color;
  }
  return DEFAULT_NODE_COLOR;
}

/** Precomputes a colour per node. Called on every rule edit, so it is a plain
 *  loop rather than anything clever -- 1,500 nodes x ~8 rules is trivial. */
export function colorAll(
  nodes: ColorableNode[],
  rules: ColorRule[],
  tagTable: TagTableEntry[],
): string[] {
  const out = new Array<string>(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    out[i] = resolveColor(nodes[i], rules, tagTable);
  }
  return out;
}

/** Which rules actually matched something, for the legend. Showing a legend
 *  entry for a colour that appears nowhere on screen is worse than showing
 *  nothing. */
export function usedRules(colors: string[], rules: ColorRule[]): ColorRule[] {
  const present = new Set(colors);
  return rules.filter((r) => r.enabled && present.has(r.color));
}

/** A human description of a rule, for the editor's compact row. */
export function describeQuery(q: ColorQuery): string {
  switch (q.type) {
    case 'tag': return `${q.kind}:${q.name}`;
    case 'kind': return `any ${q.kind}`;
    case 'path': return `path:${q.prefix}`;
    case 'media': return `type:${q.mediaType}`;
    case 'ext': return `ext:${q.ext}`;
    case 'text': return `name contains "${q.q}"`;
    case 'untagged': return 'untagged';
  }
}

/** Parses the editor's shorthand input into a structured query. Typing is
 *  faster than clicking, but the stored form stays structured so there is no
 *  parser in the hot path and no second mental model. */
export function parseQuery(input: string): ColorQuery | null {
  const raw = input.trim();
  if (!raw) return null;
  if (raw === 'untagged') return { type: 'untagged' };

  const colon = raw.indexOf(':');
  if (colon === -1) return { type: 'text', q: raw };

  const head = raw.slice(0, colon).toLowerCase();
  const tail = raw.slice(colon + 1).trim();
  if (!tail) return null;

  if (head === 'path') return { type: 'path', prefix: tail };
  if (head === 'ext') return { type: 'ext', ext: tail.replace(/^\./, '') };
  if (head === 'type' || head === 'media') {
    return { type: 'media', mediaType: tail as ColorQuery extends { mediaType: infer M } ? M : never };
  }
  if (head === 'name' || head === 'text') return { type: 'text', q: tail };

  // Anything else is read as kind:name, which covers topic:finance,
  // doctype:invoice, author:aria.chen and so on.
  if (tail === '*') return { type: 'kind', kind: head as TagKind };
  return { type: 'tag', kind: head as TagKind, name: tail };
}
