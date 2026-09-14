'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth';
import { workspaceContext } from '@/lib/data/context';
import { getRepository } from '@/lib/data';
import { writeOverlay } from '@/lib/overlay/store';
import { MAX_ADDITIONS } from '@/lib/overlay/types';
import { checkBudget, spend } from '@/lib/brief/budget';
import { classify, type Proposal } from '@/lib/agent/classify';
import { explain, type Explanation } from '@/lib/agent/explain';
import { planView, type ViewPlan, type Vocabulary } from '@/lib/agent/view';
import { findRelated, type Relation } from '@/lib/agent/related';
import { explainKey, planKey, recallAnswer, rememberAnswer } from '@/lib/agent/recall';
import { lensTagIds } from '@/lib/data/lens';
import { toSearchParams } from '@/lib/filter/params';
import { buildQueue, type Candidate } from '@/lib/agent/queue';
import { GeminiError, geminiStatus } from '@/lib/ai/gemini';
import type { Overlay } from '@/lib/overlay/types';
import type { FileId, TagId } from '@/lib/data/types';

/* The agent's two verbs: propose, and accept.
 *
 * They are separate on purpose. Proposing costs a model call and changes
 * nothing; accepting changes what this workspace sees and costs nothing. A
 * single "classify and apply" button would have tied a spend to a write and
 * made the expensive half un-reviewable, which is the opposite of what the
 * escalation is for -- the engine escalates because the rules were UNSURE, and
 * an unsure answer is exactly the kind a person should see before it lands.
 */

export type ProposeResult =
  | { ok: true; proposal: Proposal & { doctypeTagId?: number; topicTagId?: number } }
  | { ok: false; error: string };

export type AcceptResult = { ok: true } | { ok: false; error: string };

const GONE = 'That workspace is not available.';
const NO_FILE = 'That file is not in this workspace.';
const DENIED = 'You need contribute access in this workspace to accept a tag.';

/** The vocabulary the model may answer from: names that already exist as tags
 *  in this workspace's libraries. Anything else could not resolve to a tag id,
 *  so offering it would be offering something unacceptable. */
async function vocabulary(ctx: Awaited<ReturnType<typeof workspaceContext>>) {
  const tags = await getRepository().listTags(ctx!);
  const byKind = (kind: string) =>
    tags.filter((t) => t.kind === kind).map((t) => ({ name: t.name, id: t.id }));
  return { doctypes: byKind('doctype'), topics: byKind('topic') };
}

export async function proposeTags(ws: string, rawFileId: string): Promise<ProposeResult> {
  const session = await requireSession(`/w/${ws}/agent`);
  const ctx = await workspaceContext(session.user.id, ws);
  if (!ctx) return { ok: false, error: GONE };

  const status = geminiStatus();
  if (!status.configured) {
    return {
      ok: false,
      error: 'No model is configured on this server, so the agent can only show '
        + 'you which files are missing a label, not suggest one.',
    };
  }

  const repo = getRepository();
  const file = await repo.getFile(ctx, rawFileId as FileId);
  if (!file) return { ok: false, error: NO_FILE };

  /* The same budget the brief spends from, and for the same reason: one shared
     key funds every viewer of a public demo. A per-file button is cheap to
     press repeatedly, which makes the ceiling matter more here, not less. */
  const budget = await checkBudget();
  if (!budget.allowed) {
    return {
      ok: false,
      error: budget.reason
        ?? `That is ${budget.viewerLimit} model calls today, which is this demo's limit.`,
    };
  }

  const tagById = new Map((await repo.listTags(ctx)).map((t) => [t.id, t]));
  const [candidate] = buildQueue(
    [file],
    // The file is being looked at precisely because the lens leaves it bare, so
    // the queue builder is handed the same view the page used.
    (f) => (f.tags ?? []).concat(
      (f.userTags ?? [])
        .filter((u) => u.workspaceId === ctx.workspace.id)
        .map((u) => u.tagId),
      [...(ctx.addedTags?.(f.id) ?? [])],
    ).filter((id) => !ctx.isRemoved(f.id, id as TagId)),
    tagById,
    1,
  );

  if (!candidate) {
    return {
      ok: false,
      error: 'This file already has both a kind and a topic, so there is nothing '
        + 'for the agent to decide.',
    };
  }

  const { doctypes, topics } = await vocabulary(ctx);

  try {
    const proposal = await classify(
      candidate,
      doctypes.map((d) => d.name),
      topics.map((t) => t.name),
    );
    await spend();

    return {
      ok: true,
      proposal: {
        ...proposal,
        doctypeTagId: doctypes.find((d) => d.name === proposal.doctype)?.id,
        topicTagId: topics.find((t) => t.name === proposal.topic)?.id,
      },
    };
  } catch (err) {
    // The model's own message is usually the useful one -- "API key not valid"
    // and "API key expired" are different problems with different fixes.
    const detail = err instanceof GeminiError ? err.message : 'The model could not be reached.';
    return { ok: false, error: detail };
  }
}

/** Accept one proposed tag. The file must be visible to this workspace and the
 *  tag must be one the catalogue already knows, so an accepted proposal can
 *  never invent a tag id. */
export async function acceptTag(
  ws: string,
  rawFileId: string,
  tagId: number,
): Promise<AcceptResult> {
  const session = await requireSession(`/w/${ws}/agent`);
  const ctx = await workspaceContext(session.user.id, ws);
  if (!ctx) return { ok: false, error: GONE };
  if (!ctx.can('tag')) return { ok: false, error: DENIED };

  const repo = getRepository();
  const file = await repo.getFile(ctx, rawFileId as FileId);
  if (!file) return { ok: false, error: NO_FILE };

  const known = (await repo.listTags(ctx)).some((t) => t.id === tagId);
  if (!known) return { ok: false, error: 'That tag is not in this catalogue.' };

  const next: Overlay = {
    workspaceId: ctx.overlay.workspaceId,
    removals: [...ctx.overlay.removals],
    additions: [...ctx.overlay.additions],
    albums: ctx.overlay.albums.map((a) => ({ ...a, fileIds: [...a.fileIds] })),
  };

  const already = next.additions.some((a) => a.fileId === file.id && a.tagId === tagId);
  if (!already) {
    if (next.additions.length >= MAX_ADDITIONS) {
      return {
        ok: false,
        error: `This workspace has accepted ${MAX_ADDITIONS} agent suggestions, `
          + 'which is as many as a browser cookie can hold.',
      };
    }
    /* Accepting a tag this workspace had previously REMOVED would leave the
       overlay holding both opinions, and the removal wins at read time -- so
       the accept would appear to work and do nothing. Dropping the removal is
       what the person meant. */
    next.removals = next.removals.filter(
      (r) => !(r.fileId === file.id && r.tagId === tagId),
    );
    next.additions.push({ fileId: file.id, tagId: tagId as TagId });
  }

  const written = await writeOverlay(next);
  if (!written.ok) return written;

  // Counts, facets, the summary and both graph modes all read through the same
  // chokepoint, so all of them are stale after this.
  revalidatePath(`/w/${ws}`, 'layout');
  return { ok: true };
}

/* ---------------------------------------------------------------------------
 *  The agent's other verbs.
 *
 *  Label (above) picks a tag from a fixed vocabulary. These three do different
 *  jobs, and they are kept apart for the same reason propose and accept are:
 *  they differ in what they COST and in what they CHANGE. `relatedFiles` costs
 *  nothing and changes nothing. `explainFile` and `askForView` each spend one
 *  model call and change nothing. Accepting is still the only verb in this
 *  file that writes anything.
 * ------------------------------------------------------------------------- */

/** The tag lens every page reads through: this workspace's own tags included,
 *  another workspace's excluded, its corrections applied. One implementation,
 *  in lib/data/lens.ts, because the speech route has to compute the SAME ids
 *  to look up a remembered explanation -- and two hand-written copies that
 *  differ by a dedupe would simply never find each other. */
function lensOf(ctx: NonNullable<Awaited<ReturnType<typeof workspaceContext>>>) {
  return (f: {
    id: FileId;
    tags: TagId[];
    userTags?: { workspaceId: string; tagId: TagId }[];
  }): TagId[] => lensTagIds(ctx, f);
}

export type RelatedResult =
  | { ok: true; related: Relation[]; scanned: number }
  | { ok: false; error: string };

/** "What else is like this?" -- cosine similarity over idf-weighted tag
 *  vectors. No model, no budget and no limit on how often it may be asked,
 *  because it is arithmetic over an index that is already in memory. */
export async function relatedFiles(ws: string, rawFileId: string): Promise<RelatedResult> {
  const session = await requireSession(`/w/${ws}/library`);
  const ctx = await workspaceContext(session.user.id, ws);
  if (!ctx) return { ok: false, error: GONE };

  const repo = getRepository();
  const file = await repo.getFile(ctx, rawFileId as FileId);
  if (!file) return { ok: false, error: NO_FILE };

  const [page, tags] = await Promise.all([
    repo.listFiles(ctx, { limit: Number.MAX_SAFE_INTEGER }),
    repo.listTags(ctx),
  ]);

  const related = findRelated(
    file,
    page.files,
    lensOf(ctx),
    new Map(tags.map((t) => [t.id, t])),
    8,
  );

  return { ok: true, related, scanned: page.files.length };
}

export type ExplainResult =
  | { ok: true; explanation: Explanation; related: Relation[] }
  | { ok: false; error: string };

/** "What is this?" -- one model call, given the file's metadata, its folder
 *  neighbours and the files the catalogue says are most like it. */
export async function explainFile(ws: string, rawFileId: string): Promise<ExplainResult> {
  const session = await requireSession(`/w/${ws}/library`);
  const ctx = await workspaceContext(session.user.id, ws);
  if (!ctx) return { ok: false, error: GONE };

  const status = geminiStatus();
  if (!status.configured) {
    return {
      ok: false,
      error: 'No model is configured on this server, so files can be listed and '
        + 'filtered but not described.',
    };
  }

  const repo = getRepository();
  const file = await repo.getFile(ctx, rawFileId as FileId);
  if (!file) return { ok: false, error: NO_FILE };

  const [page, tags] = await Promise.all([
    repo.listFiles(ctx, { limit: Number.MAX_SAFE_INTEGER }),
    repo.listTags(ctx),
  ]);
  const tagById = new Map(tags.map((t) => [t.id, t]));
  const lens = lensOf(ctx);

  const related = findRelated(file, page.files, lens, tagById, 8);

  /* Asked before anything is spent or even checked. A remembered answer costs
     nothing, so refusing it on a budget would be refusing to show something
     this server already has -- and the reason it is kept at all is that the
     speech route can only READ BACK an explanation, never regenerate one. The
     key carries the lens, so a workspace that has since corrected a tag on
     this file gets a fresh answer rather than one describing labels it no
     longer counts. */
  const key = explainKey(ctx.workspace.id, file.id, lens(file));
  const remembered = recallAnswer(key);
  if (remembered?.kind === 'explain') {
    return { ok: true, explanation: remembered.explanation, related };
  }

  const budget = await checkBudget();
  if (!budget.allowed) {
    return {
      ok: false,
      error: budget.reason
        ?? `That is ${budget.viewerLimit} model calls today, which is this demo's limit.`,
    };
  }

  /* Folder neighbours, capped. A folder of 400 files would otherwise put 400
     names in the prompt, and the first eight say as much about what the folder
     is for as all of them would. */
  const siblings = page.files
    .filter((f) => f.id !== file.id && (f.parentRel ?? '') === (file.parentRel ?? ''))
    .slice(0, 8)
    .map((f) => f.name);

  try {
    const explanation = await explain({
      name: file.name,
      parentRel: file.parentRel ?? '',
      ext: file.ext,
      mediaType: file.mediaType,
      sizeBytes: file.sizeBytes,
      mtime: file.mtime,
      tags: lens(file)
        .map((id) => tagById.get(id)?.displayName)
        .filter((n): n is string => Boolean(n)),
      siblings,
      related,
    });
    await spend();
    rememberAnswer(key, { kind: 'explain', subject: file.name, explanation });
    return { ok: true, explanation, related };
  } catch (err) {
    const detail = err instanceof GeminiError ? err.message : 'The model could not be reached.';
    return { ok: false, error: detail };
  }
}

export type AskResult =
  | { ok: true; plan: ViewPlan; matches: number; href: string; libraryHref: string }
  | { ok: false; error: string };

const MAX_QUESTION = 300;

/** "Show me how finance and legal overlap" -- one model call that chooses a
 *  filter and a drawing, after which the CATALOGUE says how many files that
 *  is. The model is never asked for the number and never supplies one. */
export async function askForView(ws: string, rawQuestion: string): Promise<AskResult> {
  const session = await requireSession(`/w/${ws}/agent`);
  const ctx = await workspaceContext(session.user.id, ws);
  if (!ctx) return { ok: false, error: GONE };

  const question = rawQuestion.trim().slice(0, MAX_QUESTION);
  if (!question) {
    return {
      ok: false,
      error: 'Type a question first — "what did Aria Chen work on in 2024" is the shape.',
    };
  }

  const repo = getRepository();
  const key = planKey(ctx.workspace.id, question);
  const remembered = recallAnswer(key);

  let plan: ViewPlan;

  if (remembered?.kind === 'plan') {
    // Asking the same question twice is one model call. It was two, which made
    // the cheapest way to re-read an answer the most expensive thing the page
    // could do.
    plan = remembered.plan;
  } else {
    const status = geminiStatus();
    if (!status.configured) {
      return {
        ok: false,
        error: 'No model is configured on this server, so questions cannot be turned '
          + 'into views. The facet rail in the library does the same job by hand.',
      };
    }

    const budget = await checkBudget();
    if (!budget.allowed) {
      return {
        ok: false,
        error: budget.reason
          ?? `That is ${budget.viewerLimit} model calls today, which is this demo's limit.`,
      };
    }

    const tags = await repo.listTags(ctx);

    /* The vocabulary offered is THIS workspace's, so a question can never be
       answered with a tag the asker has no grant to see. Ordered by how many
       files carry each, because the prompt keeps only the head of each axis. */
    const vocab: Vocabulary = {};
    for (const tag of tags) {
      const list = vocab[tag.kind] ?? (vocab[tag.kind] = []);
      list.push({ name: tag.name, display: tag.displayName, count: tag.fileCount });
    }
    for (const list of Object.values(vocab)) list.sort((a, b) => b.count - a.count);

    try {
      plan = await planView(question, vocab);
      await spend();
    } catch (err) {
      const detail = err instanceof GeminiError ? err.message : 'The model could not be reached.';
      return { ok: false, error: detail };
    }
  }

  /* THE COUNT IS ARITHMETIC, and it is recounted even on a remembered plan.
     The filter is what was remembered; the number is not, because a tag
     accepted or corrected since would have changed it. Reading a listener a
     count the screen no longer shows is the exact failure this whole split
     exists to prevent. */
  const tagFilter = Object.keys(plan.tags).length ? plan.tags : undefined;
  const page = await repo.listFiles(ctx, {
    tags: tagFilter,
    q: plan.q,
    limit: Number.MAX_SAFE_INTEGER,
  });
  const matches = page.files.length;

  // Re-remembered with the fresh count, so what is spoken is what is shown.
  rememberAnswer(key, { kind: 'plan', question, plan, matches });

  const sp = toSearchParams({ tags: tagFilter, q: plan.q });
  const libraryHref = `/w/${ws}/library${sp.toString() ? `?${sp}` : ''}`;
  sp.set('mode', plan.mode);

  return {
    ok: true,
    plan,
    matches,
    href: `/w/${ws}/graph?${sp}`,
    libraryHref,
  };
}

export type { Candidate };
export type { Relation } from '@/lib/agent/related';
