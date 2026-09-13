import { getRepository } from '@/lib/data';
import { library } from '@/lib/data/json/load';
import { lensedTags } from '@/lib/data/lens';
import { findRelated } from '@/lib/agent/related';
import { explain } from '@/lib/agent/explain';
import { checkBudget, spend } from '@/lib/brief/budget';
import { geminiStatus, GeminiError } from '@/lib/ai/gemini';
import { apiJson, apiWorkspace, fail } from '@/lib/api/route';
import type { ExplainResponse } from '@/lib/api/types';
import type { FileId } from '@/lib/data/types';

/* "What is this file?" -- one model call, POST because it spends one.
 *
 * The same evidence the browser panel sends: the file's metadata, the labels
 * already on it, its folder neighbours and its nearest files by tag
 * similarity. No content, because the catalogue holds none, and `unknowns` in
 * the reply is where that limit is stated rather than glossed.
 */

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ ws: string; id: string }> },
) {
  const { ws, id } = await params;
  const gate = await apiWorkspace(ws);
  if ('response' in gate) return gate.response;
  const { ctx } = gate;

  if (!geminiStatus().configured) {
    return fail(
      503,
      'No model is configured on this server, so files can be listed and filtered but not described.',
      'Everything else in this API works without one.',
    );
  }

  const repo = getRepository();
  const file = await repo.getFile(ctx, id as FileId);
  if (!file) return fail(404, 'No such file in this workspace.');

  const budget = await checkBudget();
  if (!budget.allowed) {
    return fail(429, budget.reason ?? 'Out of model calls for today.', 'Resets at midnight UTC.');
  }

  const tagById = new Map<number, { kind: string; name: string; displayName: string }>();
  for (const lid of new Set(ctx.grants.map((g) => g.libraryId))) {
    for (const t of library(lid).tags) tagById.set(t.id, t);
  }
  const byId = new Map((await repo.listTags(ctx)).map((t) => [t.id as number, t]));
  const lens = (f: typeof file) => lensedTags(ctx, f, tagById).tags.map((t) => t.id);

  const pool = await repo.listFiles(ctx, { limit: Number.MAX_SAFE_INTEGER });
  const related = findRelated(file, pool.files, lens, byId, 8);

  const siblings = pool.files
    .filter((f) => f.id !== file.id && (f.parentRel ?? '') === (file.parentRel ?? ''))
    .slice(0, 8)
    .map((f) => f.name);

  try {
    const result = await explain({
      name: file.name,
      parentRel: file.parentRel ?? '',
      ext: file.ext,
      mediaType: file.mediaType,
      sizeBytes: file.sizeBytes,
      mtime: file.mtime,
      tags: lensedTags(ctx, file, tagById).tags.map((t) => t.display),
      siblings,
      related,
    });
    await spend();

    return apiJson<ExplainResponse>({
      summary: result.summary,
      reads: result.reads,
      unknowns: result.unknowns,
      confidence: result.confidence,
      model: result.model,
    });
  } catch (err) {
    const detail = err instanceof GeminiError ? err.message : 'The model could not be reached.';
    return fail(502, detail);
  }
}
