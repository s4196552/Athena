import 'server-only';
import { generate, MODEL } from '../ai/gemini';
import { formatBytes } from '../format';
import type { Relation } from './related';

/* EXPLAINING A FILE.
 *
 * The sibling of classify.ts, asking a different question. classify picks a
 * label from a fixed vocabulary; this one writes a sentence a person reads.
 * Both operate under the same hard limit, which is restated here rather than
 * cross-referenced because it is the thing most likely to be forgotten:
 *
 *   THE ENGINE READS THE FILE. THIS DOES NOT.
 *
 * What makes this worth doing anyway is that it is given strictly more than
 * classify gets. Alongside the name and folder it receives the tags the
 * classifier already assigned, the other files in the same folder, and the
 * files the catalogue says are most similar -- so it is explaining a file IN
 * CONTEXT rather than guessing at a string. "A quarterly statement, one of
 * eleven in this folder, filed with the same author and pattern tags as the
 * 2024 series" is a real answer, and every clause in it is checkable.
 *
 * `unknowns` is the load-bearing field. A model asked to describe a file it
 * cannot open will describe one anyway, fluently, and the result is
 * indistinguishable from knowledge. Requiring it to list what it could NOT
 * determine turns the limit into part of the answer, and the UI prints that
 * list as prominently as the summary.
 *
 * WHAT LEAVES THE SERVER: one file's name, folder, extension, media type,
 * size, date and tag NAMES, plus the names of up to eight neighbours. No file
 * content, because the catalogue holds none.
 */

const SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description:
        'Two or three sentences saying what this file most likely is and what '
        + 'it is probably for. Hedge where the evidence is thin.',
    },
    reads: {
      type: 'array',
      items: { type: 'string' },
      description:
        'The specific pieces of evidence used, one short clause each, quoting '
        + 'the word or tag it came from. At most four.',
    },
    unknowns: {
      type: 'array',
      items: { type: 'string' },
      description:
        'What cannot be determined without opening the file. At most three, '
        + 'each a short phrase. Never empty -- there is always something.',
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description: 'How much the evidence actually supports the summary.',
    },
  },
  required: ['summary', 'reads', 'unknowns', 'confidence'],
} as const;

export interface Explanation {
  summary: string;
  reads: string[];
  unknowns: string[];
  confidence: 'high' | 'medium' | 'low';
  model: string;
}

export interface ExplainSubject {
  name: string;
  parentRel: string;
  ext: string;
  mediaType: string;
  sizeBytes: number;
  mtime: number;
  /** Display names of the tags this workspace counts on the file. */
  tags: string[];
  /** Names of other files in the same folder. Capped by the caller. */
  siblings: string[];
  /** The catalogue's own answer to "what else is like this", from related.ts. */
  related: Relation[];
}

export function explainPrompt(f: ExplainSubject): string {
  const lines = [
    'You are describing one file in a searchable library, for the person who',
    'owns it.',
    '',
    'YOU CANNOT SEE THE FILE. You cannot open it, and no part of its contents',
    'is available to you. Everything below is metadata: a name, a folder, and',
    'labels a classifier assigned earlier from the same kind of evidence.',
    'Describe what that supports and nothing beyond it.',
    '',
    `Name: ${f.name}`,
    `Folder: ${f.parentRel || '(the library root)'}`,
    `Extension: ${f.ext || '(none)'}`,
    `Media type: ${f.mediaType}`,
    `Size: ${formatBytes(f.sizeBytes)}`,
    `Modified: ${new Date(f.mtime).toISOString().slice(0, 10)}`,
    '',
    f.tags.length
      ? `Labels already on it: ${f.tags.join(', ')}`
      : 'Labels already on it: none -- nothing in it matched the classifier.',
  ];

  if (f.siblings.length) {
    lines.push('', `Other files in the same folder: ${f.siblings.join(', ')}`);
  }

  if (f.related.length) {
    lines.push(
      '',
      'The catalogue computes which files are most similar to this one, by',
      'weighted overlap of their labels. The closest are:',
      ...f.related.slice(0, 5).map(
        (r) => `- ${r.name} (shares ${r.shared.map((t) => t.display).join(', ') || 'nothing notable'})`,
      ),
    );
  }

  lines.push(
    '',
    'Write a summary of two or three sentences. Say what kind of thing this is',
    'and what it is likely for. Where the evidence runs out, say so in the',
    'sentence rather than guessing past it -- "appears to be", "filed as",',
    '"one of several" are all honest and useful.',
    '',
    'Never state anything as a fact about the CONTENTS. You have not read',
    'them. A confident description of a file nobody opened is worse than a',
    'hedged one, because the reader cannot tell which parts you knew.',
    '',
    'In reads, quote the word, folder or label each conclusion came from.',
    'In unknowns, list what someone would have to open the file to learn.',
    'Do not repeat the file name back as if it were a finding.',
  );

  return lines.join('\n');
}

export async function explain(subject: ExplainSubject): Promise<Explanation> {
  const raw = (await generate(explainPrompt(subject), SCHEMA, 500)) as Record<string, unknown>;

  const list = (value: unknown, limit: number): string[] =>
    (Array.isArray(value) ? value : [])
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map((x) => x.trim().slice(0, 200))
      .slice(0, limit);

  const confidence = String(raw?.confidence ?? '').toLowerCase();

  return {
    summary: String(raw?.summary ?? '').trim().slice(0, 900),
    reads: list(raw?.reads, 4),
    /* If the model returns an empty `unknowns` despite being told not to, the
       UI must not silently imply there are none. A file nobody opened always
       has unknowns, so the honest default is stated here rather than left to
       the renderer to remember. */
    unknowns: list(raw?.unknowns, 3).length
      ? list(raw?.unknowns, 3)
      : ['anything that is actually inside the file'],
    confidence: confidence === 'high' || confidence === 'medium' ? confidence : 'low',
    model: MODEL,
  };
}
