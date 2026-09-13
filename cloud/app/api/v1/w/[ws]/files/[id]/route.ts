import { getRepository } from '@/lib/data';
import { library } from '@/lib/data/json/load';
import { lensedTags } from '@/lib/data/lens';
import { findRelated } from '@/lib/agent/related';
import { apiJson, apiWorkspace, fail } from '@/lib/api/route';
import type { FileDetailResponse } from '@/lib/api/types';
import type { FileId } from '@/lib/data/types';

/* One file, with its neighbours.
 *
 * Related files are included rather than being a second endpoint, because they
 * cost nothing -- cosine similarity over idf-weighted tag vectors, arithmetic
 * over an index already in memory -- and a client that has to ask twice for
 * something free will usually ask once and show less. The detail panel in the
 * browser makes the same call for the same reason.
 */

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ ws: string; id: string }> },
) {
  const { ws, id } = await params;
  const gate = await apiWorkspace(ws);
  if ('response' in gate) return gate.response;
  const { ctx } = gate;

  const repo = getRepository();
  const file = await repo.getFile(ctx, id as FileId);
  if (!file) {
    return fail(
      404,
      'No such file in this workspace.',
      'Ids come from `athena-cloud ls`; a grant that excludes a folder hides its files here too.',
    );
  }

  const tagById = new Map<number, { kind: string; name: string; displayName: string }>();
  for (const lid of new Set(ctx.grants.map((g) => g.libraryId))) {
    for (const t of library(lid).tags) tagById.set(t.id, t);
  }

  const { tags, removed } = lensedTags(ctx, file, tagById);

  /* findRelated needs each tag's idf, which the display map above does not
     carry -- the lens wants three fields and the similarity wants a different
     one, so they stay two maps rather than one wide one. */
  const byId = new Map((await repo.listTags(ctx)).map((t) => [t.id as number, t]));

  const pool = await repo.listFiles(ctx, { limit: Number.MAX_SAFE_INTEGER });
  const related = findRelated(
    file,
    pool.files,
    (f) => lensedTags(ctx, f, tagById).tags.map((t) => t.id),
    byId,
    8,
  );

  const shape = (list: typeof tags) =>
    list.map((t) => ({
      kind: t.kind,
      name: t.name,
      display: t.display,
      ...(t.user ? { user: true } : {}),
    }));

  return apiJson<FileDetailResponse>({
    file: {
      id: file.id,
      name: file.name,
      relPath: file.relPath,
      parentRel: file.parentRel ?? '',
      ext: file.ext,
      mediaType: file.mediaType,
      sizeBytes: file.sizeBytes,
      mtime: file.mtime,
      tags: shape(tags),
    },
    removed: shape(removed),
    related: related.map((r) => ({
      fileId: r.fileId,
      name: r.name,
      relPath: r.relPath,
      score: r.score,
      shared: r.shared.map((t) => ({ name: t.name, display: t.display, kind: t.kind })),
      sameFolder: r.sameFolder,
    })),
  });
}
