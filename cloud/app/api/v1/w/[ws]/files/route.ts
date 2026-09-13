import { getRepository } from '@/lib/data';
import { library } from '@/lib/data/json/load';
import { lensedTags } from '@/lib/data/lens';
import { parseFilterParams, toSearchParams } from '@/lib/filter/params';
import { apiJson, apiWorkspace } from '@/lib/api/route';
import type { ApiFile, FilesResponse } from '@/lib/api/types';

/* The library, as JSON.
 *
 * Takes exactly the parameters the library PAGE takes -- `?topic=finance`,
 * `?q=statement`, `?cursor=240` -- parsed by the same codec. That is not a
 * convenience: it means a URL a person is looking at in a browser can have
 * `/w/` swapped for `/api/v1/w/` and answer the same question, and it means
 * the CLI cannot drift from the UI on filter semantics, because there is only
 * one implementation of them.
 */

export async function GET(
  request: Request,
  { params }: { params: Promise<{ ws: string }> },
) {
  const { ws } = await params;
  const gate = await apiWorkspace(ws);
  if ('response' in gate) return gate.response;
  const { ctx } = gate;

  const url = new URL(request.url);
  const query = parseFilterParams(url.searchParams);

  /* A caller-supplied limit, bounded. Left open, `?limit=999999` turns a
     public endpoint into a way to pull the whole catalogue in one request --
     which is 6,120 records of JSON on this seed and would be worse on a real
     one. The page size the UI uses is the default. */
  const asked = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 500) : 120;

  const repo = getRepository();
  const page = await repo.listFiles(ctx, { ...query, limit });

  const tagById = new Map<number, { kind: string; name: string; displayName: string }>();
  for (const id of new Set(ctx.grants.map((g) => g.libraryId))) {
    for (const t of library(id).tags) tagById.set(t.id, t);
  }

  const files: ApiFile[] = page.files.map((f) => ({
    id: f.id,
    name: f.name,
    relPath: f.relPath,
    parentRel: f.parentRel ?? '',
    ext: f.ext,
    mediaType: f.mediaType,
    sizeBytes: f.sizeBytes,
    mtime: f.mtime,
    tags: lensedTags(ctx, f, tagById).tags.map((t) => ({
      kind: t.kind,
      name: t.name,
      display: t.display,
      ...(t.user ? { user: true } : {}),
    })),
  }));

  /* The filter echoed back, canonicalised. A mistyped axis -- `?topics=` for
     `?topic=` -- is silently ignored by the parser and produces the whole
     library, which from the outside is indistinguishable from a filter that
     matched everything. Showing what was understood is how a client can tell
     those apart, and the CLI prints it above the table. */
  const filter: Record<string, string> = {};
  for (const [k, v] of toSearchParams(query)) filter[k] = v;

  return apiJson<FilesResponse>({
    total: page.total,
    offset: Number(query.cursor ?? 0),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    files,
    filter,
  });
}
