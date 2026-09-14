import 'server-only';
import type { Explanation } from './explain';
import type { ViewPlan } from './view';

/* What the agent last said, kept so it can be said again.
 *
 * This exists because of one rule, restated here rather than cross-referenced
 * because it is the thing the whole speech path hangs on:
 *
 *   THE CALLER DOES NOT SUPPLY THE TEXT.
 *
 * lib/ai/elevenlabs.ts argues it at length -- an endpoint that speaks whatever
 * it is posted is a free text-to-speech service for anyone who can reach the
 * login screen, billed to one shared key. The brief satisfies that rule by
 * being REBUILT server-side from the catalogue: it is arithmetic, so producing
 * it twice is free and produces the same words.
 *
 * The agent's answers are not. An explanation and a view plan come out of a
 * model call, so there are only two ways for the speech route to obtain the
 * text it is being asked to read: ask the model again, or remember what it
 * said. Asking again would mean a button labelled "Listen" quietly spends a
 * model call to re-generate prose that is already rendered on the screen in
 * front of the person, and would sometimes read them DIFFERENT words than the
 * ones they are looking at, because the model is not deterministic. Both of
 * those are worse than not having the feature.
 *
 * So the answer is remembered at the moment it is produced, and the speech
 * route reads back that exact text or refuses. A refusal is honest here: it
 * means "ask first", and the answer is one press away.
 *
 * It earns its keep twice. The same memory makes pressing "Ask the agent" on a
 * file you already asked about cost nothing, which it previously did not --
 * every press was a fresh call for an answer that had not changed.
 *
 * SEPARATE FROM THE BRIEF'S CACHE, deliberately. lib/brief/budget.ts exports a
 * perfectly good `cached`/`remember` pair, and sharing it would mean a burst of
 * explanations evicting the briefs, since both would be competing for the same
 * two hundred slots. Two different things with two different access patterns
 * get two counters, the same argument lib/speech/budget.ts makes for counting
 * characters rather than sharing the model call counter.
 *
 * Module memory, so a request landing on a cold lambda misses. That is the
 * expected case on Vercel and the UI is built for it: the Listen button appears
 * only once an answer is on screen, and if the memory has since been lost the
 * route says so in a sentence rather than inventing a replacement.
 */

export type AgentAnswer =
  | { kind: 'explain'; subject: string; explanation: Explanation }
  | { kind: 'plan'; question: string; plan: ViewPlan; matches: number };

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 200;

const answers = new Map<string, { answer: AgentAnswer; at: number }>();

export function rememberAnswer(key: string, answer: AgentAnswer): void {
  if (answers.size >= MAX_ENTRIES) {
    // Oldest first. Map preserves insertion order, and an answer is replayed
    // within minutes of being produced or not at all -- which is not enough
    // re-reading to earn LRU bookkeeping.
    const oldest = answers.keys().next().value;
    if (oldest !== undefined) answers.delete(oldest);
  }
  answers.set(key, { answer, at: Date.now() });
}

export function recallAnswer(key: string): AgentAnswer | undefined {
  const hit = answers.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > TTL_MS) {
    answers.delete(key);
    return undefined;
  }
  return hit.answer;
}

/* The key for an explanation.
 *
 * Scoped to the workspace, because an explanation quotes the labels a
 * workspace counts and those differ between them. It also carries a
 * fingerprint of THE LENS -- the tag ids visible on that file to this
 * particular viewer, corrections applied -- because the overlay lives in a
 * browser cookie rather than in the workspace. Two people in the same
 * workspace can therefore be looking at different labels on the same file, and
 * keying on the workspace alone would read one of them an explanation built
 * from the other's accepted tags. Not a tenancy leak; simply the wrong answer,
 * delivered confidently.
 */
export function explainKey(workspaceId: string, fileId: string, tagIds: number[]): string {
  const lens = [...tagIds].sort((a, b) => a - b).join(',');
  return `explain|${workspaceId}|${fileId}|${fnv(lens)}`;
}

/** The key for a view plan. The question is what varies; the vocabulary the
 *  model may answer from is fixed by the workspace, so that is the whole key.
 *  Normalised, so the same question typed with different spacing or capitals
 *  is one remembered answer rather than two model calls. */
export function planKey(workspaceId: string, question: string): string {
  const normal = question.trim().toLowerCase().replace(/\s+/g, ' ');
  return `plan|${workspaceId}|${fnv(normal)}`;
}

/** FNV-1a. Not a checksum anyone relies on -- it only has to make "the same
 *  input" and "different input" different keys within one process. */
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
