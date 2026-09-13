import 'server-only';
import { generate, MODEL } from '../ai/gemini';
import type { Candidate } from './queue';

/* ASKING THE MODEL WHAT A FILE IS.
 *
 * This is the web app's version of the ML tier in athena/agent/inspect.py --
 * the escalation that runs when the rules are unsure. It differs from the
 * engine's in one way that has to be said out loud rather than glossed:
 *
 *   THE ENGINE READS THE FILE. THIS DOES NOT.
 *
 * `classify_prompt` in the engine is handed extracted text, or an image. The
 * seeded catalogue has neither -- it holds names, sizes, dates and tag ids and
 * nothing else -- so the only evidence available here is the file's name, its
 * folder, its extension and its media type.
 *
 * That is weaker, but it is not nothing, and it is evidence the engine uses
 * too: `Evidence.name_key` is "filename and parent folder, lowercased", with
 * the comment that a file inside `2024/Invoices/` is evidence about the file
 * "even when the file itself is called scan0042.pdf, which is exactly what a
 * scanner names things". So this asks the same question from a strict subset of
 * the same evidence, and the UI labels every answer with what it was given.
 *
 * WHAT LEAVES THE SERVER: one file's name, folder, extension, media type and
 * size. That is more than the brief sends -- the brief is counts only -- and it
 * is the reason this is a per-file button somebody presses rather than
 * something that runs over a library on its own.
 *
 * The model may only answer from the vocabulary the library already uses. Two
 * reasons: an accepted proposal has to resolve to a real tag id, and a
 * free-text label would quietly grow a second vocabulary beside the engine's.
 */

const SCHEMA = {
  type: 'object',
  properties: {
    doctype: {
      type: 'string',
      description: 'The chosen doctype name, exactly as listed, or "" if unsure.',
    },
    topic: {
      type: 'string',
      description: 'The chosen topic name, exactly as listed, or "" if unsure.',
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description: 'How much the name and folder actually support this.',
    },
    reasoning: {
      type: 'string',
      description: 'One sentence, naming the words that decided it.',
    },
  },
  required: ['doctype', 'topic', 'confidence', 'reasoning'],
} as const;

export interface Proposal {
  doctype: string | null;
  topic: string | null;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  model: string;
}

export function classifyPrompt(
  file: Candidate,
  doctypes: string[],
  topics: string[],
): string {
  return [
    'You are classifying one file in a searchable library.',
    '',
    'You CANNOT see the file. You are given only its name, the folder it sits',
    'in, its extension and its media type. Decide only what those support.',
    '',
    `Name: ${file.name}`,
    `Folder: ${file.parentRel || '(the library root)'}`,
    `Extension: ${file.ext || '(none)'}`,
    `Media type: ${file.mediaType}`,
    '',
    'Choose at most one doctype and at most one topic, using these names',
    'EXACTLY as written. If the evidence does not support a choice on an axis,',
    'return an empty string for it -- that is a normal answer, not a failure.',
    'A confident wrong label is worse than none: it files something where',
    'nobody will look for it, and they will never think to check the bucket it',
    'was wrongly put in.',
    '',
    `doctype: ${doctypes.join(', ')}`,
    `topic: ${topics.join(', ')}`,
    '',
    'Set confidence to "high" only when the name or folder names the thing',
    'outright. A plausible guess from a generic name is "low".',
    'In reasoning, quote the part of the name or folder you used.',
  ].join('\n');
}

export async function classify(
  file: Candidate,
  doctypes: string[],
  topics: string[],
): Promise<Proposal> {
  const raw = (await generate(
    classifyPrompt(file, doctypes, topics),
    SCHEMA,
    300,
  )) as Record<string, unknown>;

  /* Validated against the offered vocabulary rather than trusted. A schema
     constrains the SHAPE of the answer, not its contents: the model can still
     return a doctype that was not on the list, and an unknown name would have
     no tag id to resolve to. */
  const pick = (value: unknown, allowed: string[]): string | null => {
    const name = String(value ?? '').trim().toLowerCase();
    return name && allowed.includes(name) ? name : null;
  };

  const confidence = String(raw?.confidence ?? '').toLowerCase();

  return {
    doctype: pick(raw?.doctype, doctypes),
    topic: pick(raw?.topic, topics),
    confidence: confidence === 'high' || confidence === 'medium' ? confidence : 'low',
    reasoning: String(raw?.reasoning ?? '').trim().slice(0, 400),
    model: MODEL,
  };
}
