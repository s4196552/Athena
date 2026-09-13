'use server';

import { requireSession } from '@/lib/auth';
import { workspaceContext } from '@/lib/data/context';
import { getRepository } from '@/lib/data';
import { library } from '@/lib/data/json/load';
import { parseFilterParams, toSearchParams } from '@/lib/filter/params';
import { buildDigest } from '@/lib/brief/digest';
import { compileBrief, briefPrompt } from '@/lib/brief/compile';
import { cached, checkBudget, remember, spend } from '@/lib/brief/budget';
import { GeminiError, geminiKey, writeProse, type BriefProse } from '@/lib/ai/gemini';
import type { FileRecord, TagRecord } from '@/lib/data/types';

/* "Summarise this selection."
 *
 * The user flow from athena/agent/brief.py, brought to the web: filter to
 * Finance + Aria Chen, look at eleven documents, and ask what they add up to.
 * That is a question about a SET, which is the thing a file manager has never
 * been able to answer.
 *
 * The counted brief is always produced. The model only ever adds an opening
 * paragraph on top of it, and only when a key is configured, the budget allows
 * it, and the call succeeds. Every failure path below degrades to the counted
 * brief rather than to an error, because the counted brief is the answer and
 * the prose is the garnish.
 */

export interface BriefResult {
  title: string;
  /** Markdown. Always present. */
  body: string;
  /** Model prose, when there was a model. */
  intro?: string;
  themes?: string[];
  about?: string[];
  producedBy: string;
  /** Why there is no prose, when there is none. Shown quietly, not as an error. */
  note?: string;
  files: number;
}

export async function summarise(ws: string, queryString: string): Promise<BriefResult> {
  const session = await requireSession(`/w/${ws}/library`);
  const ctx = await workspaceContext(session.user.id, ws);
  if (!ctx) {
    return {
      title: 'Not available', body: 'That workspace is not available.',
      producedBy: 'none', files: 0,
    };
  }

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
  if (hit) return withProse(base, hit, ' (cached)');

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
