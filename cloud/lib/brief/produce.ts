import 'server-only';

import { getRepository } from '../data';
import { library } from '../data/json/load';
import { parseFilterParams, toSearchParams } from '../filter/params';
import { buildDigest } from './digest';
import { compileBrief, briefPrompt } from './compile';
import { cached, checkBudget, remember, spend } from './budget';
import { GeminiError, geminiKey, writeProse, type BriefProse } from '../ai/gemini';
import type { WorkspaceContext } from '../data/repository';
import type { FileRecord, TagRecord } from '../data/types';
import type { BriefResult } from './types';

export type { BriefResult };

/* Producing a brief, separately from the server action that used to hold this.
 *
 * It was lifted out when "read this aloud" needed the same brief that is on
 * screen. The speech route could have called the action, but that would have
 * made pressing Listen able to SPEND A MODEL CALL -- the panel is open, so the
 * prose already exists, but a request landing on a different lambda instance
 * misses the module-memory cache and would quietly write a new one. Paying
 * Google to produce text that is already rendered in front of the person is a
 * bad trade, and an invisible one.
 *
 * Hence `model`. The action asks for 'allow'; the speech route asks for
 * 'cached-only', which uses prose if this instance has it and otherwise reads
 * the counted brief -- the half that carries every number anyway.
 */

export interface ProduceOptions {
  /** 'allow' may spend one model call on a cache miss. 'cached-only' never
   *  calls out, so it cannot cost anything. */
  model?: 'allow' | 'cached-only';
}

export async function produceBrief(
  ctx: WorkspaceContext,
  queryString: string,
  opts: ProduceOptions = {},
): Promise<BriefResult> {
  const mode = opts.model ?? 'allow';

  const repo = getRepository();
  const query = parseFilterParams(new URLSearchParams(queryString));
  // No limit: a brief describes the whole selection, not the first page of it.
  const page = await repo.listFiles(ctx, { ...query, limit: Number.MAX_SAFE_INTEGER });

  const tagById = new Map<number, TagRecord>();
  for (const id of new Set(ctx.grants.map((g) => g.libraryId))) {
    for (const t of library(id).tags) tagById.set(t.id, t);
  }

  /* The same tag lens the rest of the app reads through: this workspace's user
     tags included, another workspace's excluded, and this workspace's
     corrections applied. A brief that counted a tag the library had already
     been told was wrong would undo the correction in the one place people go
     for a summary. */
  const tagIdsOf = (f: FileRecord): number[] => {
    const own = f.userTags?.filter((u) => u.workspaceId === ctx.workspace.id).map((u) => u.tagId);
    const all = own?.length ? [...f.tags, ...own] : f.tags;
    return ctx.overlay.removals.length ? all.filter((id) => !ctx.isRemoved(f.id, id)) : all;
  };

  const digest = buildDigest(page.files, tagById, tagIdsOf);
  const label = describe(query);
  const { title, body } = compileBrief(digest, label);

  const base: BriefResult = { title, body, producedBy: 'counted', files: digest.count };
  if (digest.count === 0) return base;

  if (!geminiKey()) {
    return {
      ...base,
      note: 'No GEMINI_API_KEY is configured, so this is the counted summary only.',
    };
  }

  // Canonical query string, so the same selection reached by a different
  // parameter order is one cache entry rather than two.
  const key = `${ctx.workspace.id}|${toSearchParams(query).toString()}|${digest.count}`;
  const hit = cached<BriefProse>(key);
  if (hit) return withProse(base, hit, mode === 'cached-only' ? '' : ' (cached)');

  // A miss in 'cached-only' is not a failure. The counted brief is the answer;
  // the prose is the garnish, and this caller does not buy garnish.
  if (mode === 'cached-only') return base;

  const budget = await checkBudget();
  if (!budget.allowed) return { ...base, note: budget.reason };

  try {
    const prose = await writeProse(briefPrompt(digest, label));
    await spend();
    remember(key, prose);
    return withProse(base, prose);
  } catch (err) {
    // A vendor being down must not take the brief with it.
    const note = err instanceof GeminiError
      ? `The model could not be reached (${err.message.slice(0, 120)}). This is the counted summary.`
      : 'The model could not be reached. This is the counted summary.';
    return { ...base, note };
  }
}

/** The canonical cache key for a selection, so the speech cache in
 *  lib/speech/budget.ts keys audio the same way the prose cache keys text --
 *  two parameter orders are one recording, not two. */
export function selectionKey(ctx: WorkspaceContext, queryString: string): string {
  const query = parseFilterParams(new URLSearchParams(queryString));
  return `${ctx.workspace.id}|${toSearchParams(query).toString()}`;
}

function withProse(base: BriefResult, prose: BriefProse, suffix = ''): BriefResult {
  return {
    ...base,
    intro: prose.description || undefined,
    themes: prose.topics.length ? prose.topics : undefined,
    about: prose.objects.length ? prose.objects : undefined,
    producedBy: `${prose.model}${suffix}`,
  };
}

/** The human name for a filter, reused from the graph route's `describe`. */
function describe(query: { tags?: Record<string, string[]>; q?: string; albumId?: string }): string {
  const parts: string[] = [];
  if (query.q) parts.push(`"${query.q}"`);
  for (const names of Object.values(query.tags ?? {})) {
    if (names.length) parts.push(names.join(' or '));
  }
  return parts.join(' · ');
}
