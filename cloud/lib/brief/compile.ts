import type { Digest } from './digest';
import { formatBytes } from '../format';

/* Rendering a digest, and the prompt that turns one into prose.
 *
 * Ported from compile_brief() / BRIEF_PROMPT in athena/agent/brief.py. The
 * deterministic brief is NOT a degraded fallback for "no API key", and the
 * comment in the Python is worth repeating because the temptation to treat it
 * as one is constant: "Eleven invoices from two authors between March and May
 * 2024" is a better answer than generated prose, because every figure in it is
 * arithmetic over extracted values rather than a model's recollection of them.
 *
 * The model's advantage is saying what a set is ABOUT. So it gets the numbers
 * as given facts and is told not to restate them.
 */

const MAX_ROWS = 8;

function line(label: string, rows: [string, number][]): string[] {
  if (!rows.length) return [];
  return [
    `### ${label}`,
    ...rows.slice(0, MAX_ROWS).map(([name, n]) => `- ${name} — ${n.toLocaleString()}`),
    '',
  ];
}

export function compileBrief(d: Digest, label: string): { title: string; body: string } {
  if (d.count === 0) {
    return { title: 'Nothing selected', body: 'No files match this filter.' };
  }

  const what = d.doctypes[0]?.[0]?.toLowerCase();
  const about = d.topics[0]?.[0]?.toLowerCase();
  const title = what && about
    ? `${d.count.toLocaleString()} ${what} files, mostly ${about}`
    : `${d.count.toLocaleString()} files${label ? ` — ${label}` : ''}`;

  const span = d.earliest && d.latest
    ? `${new Date(d.earliest).getFullYear()}–${new Date(d.latest).getFullYear()}`
    : '';

  const lines: string[] = [
    `**${d.count.toLocaleString()} ${d.count === 1 ? 'file' : 'files'}**`
    + `, ${formatBytes(d.totalBytes)}`
    + (span ? `, modified ${span}` : '')
    + (label ? `, matching ${label}` : '')
    + '.',
    '',
  ];

  if (d.flags.length) {
    lines.push('### Worth a look', ...d.flags.map((f) => `- ${f}`), '');
  }

  lines.push(
    ...line('What these are', d.doctypes),
    ...line('What they are about', d.topics),
    ...line('Who they came from', d.authors),
    ...line('Named in them', d.entities),
    ...line('What they contain', d.patterns),
    ...line('Where they live', d.folders),
  );

  if (d.years.length) {
    lines.push('### When');
    lines.push(d.years.map(([y, n]) => `${y} (${n.toLocaleString()})`).join(', ') + '.');
    if (d.undated) {
      lines.push('', `${d.undated.toLocaleString()} carry no date in their content.`);
    }
    lines.push('');
  }

  return { title, body: lines.join('\n').trim() };
}

/** The compact form handed to the model. Counts only -- see lib/ai/gemini.ts
 *  for exactly what leaves the server and why it is this and nothing more. */
export function digestText(d: Digest, label: string): string {
  const list = (rows: [string, number][], n = 6) =>
    rows.slice(0, n).map(([name, c]) => `${name} (${c})`).join(', ') || 'none';

  return [
    `Selection: ${label || 'the whole library'}`,
    `Files: ${d.count}`,
    `Kinds: ${list(d.doctypes)}`,
    `Topics: ${list(d.topics)}`,
    `Authors: ${list(d.authors)}`,
    `Named entities: ${list(d.entities)}`,
    `Structural patterns found in the text: ${list(d.patterns, 8)}`,
    `Folders: ${list(d.folders)}`,
    `Years: ${list(d.years, 8)}`,
    `Media types: ${list(d.mediaTypes)}`,
  ].join('\n');
}

export const BRIEF_PROMPT = `You are summarising a set of files in a searchable library for the person who owns them.

You are given COUNTS ONLY -- a roll-up of tags a classifier already assigned. You cannot see the files, their names or their contents.

Write:
- "description": two or three sentences saying what this set of files IS and what someone would use it for. Describe the collection, not the counting. Do not restate the numbers -- they are already shown to the reader directly beneath your text, and repeating them is the one thing that makes a summary feel generated.
- "topics": up to five recurring themes, lowercase.
- "objects": up to six subjects, projects or entities these are mostly about.

Be concrete and say only what the counts support. If the selection is incoherent, say so plainly rather than inventing a theme for it.

---
{digest}`;

export function briefPrompt(d: Digest, label: string): string {
  return BRIEF_PROMPT.replace('{digest}', digestText(d, label));
}
