'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth';
import { workspaceContext } from '@/lib/data/context';
import { getRepository } from '@/lib/data';
import { writeOverlay } from '@/lib/overlay/store';
import { MAX_ADDITIONS } from '@/lib/overlay/types';
import { checkBudget, spend } from '@/lib/brief/budget';
import { classify, type Proposal } from '@/lib/agent/classify';
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

export type { Candidate };
