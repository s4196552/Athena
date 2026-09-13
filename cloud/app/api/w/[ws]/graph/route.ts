import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getRepository } from '@/lib/data';
import { workspaceContext } from '@/lib/data/context';
import { library } from '@/lib/data/json/load';
import { buildTagGraph } from '@/lib/graph/tagGraph';
import { induceFileGraph } from '@/lib/graph/fileGraph';
import { DEFAULT_FILE_NODES, MAX_FILE_NODES } from '@/lib/graph/constants';
import { parseFilterParams } from '@/lib/filter/params';
import type { FileRecord, TagRecord, LibraryId } from '@/lib/data/types';

/* Serves whichever graph the view asked for.
 *
 * Both modes read the same selection, so switching the toggle never changes
 * what is being looked at -- only how it is drawn.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ ws: string }> },
) {
  const { ws } = await params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'not signed in' }, { status: 401 });

  const repo = getRepository();
  const ctx = await workspaceContext(session.user.id, ws);
  if (!ctx) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const url = new URL(request.url);
  const mode = url.searchParams.get('mode') === 'tags' ? 'tags' : 'files';
  const query = parseFilterParams(url.searchParams);

  const page = await repo.listFiles(ctx, { ...query, limit: Number.MAX_SAFE_INTEGER });
  const selected = page.files;

  // Tag lookup spans every granted library, because a workspace can hold
  // grants on more than one and the selection may mix them.
  const tagById = new Map<number, TagRecord>();
  for (const id of new Set(ctx.grants.map((g) => g.libraryId))) {
    for (const t of library(id).tags) tagById.set(t.id, t);
  }

  /* Machine tags plus THIS workspace's user tags. Another workspace's `custom`
     tags are invisible by construction -- they carry a workspaceId and are
     filtered here, which is why Marketing and Finance can share a catalogue
     and still not see each other's annotations. */
  const tagIdsOf = (f: FileRecord): number[] => {
    const own = f.userTags?.filter((u) => u.workspaceId === ctx.workspace.id).map((u) => u.tagId);
    const all = own?.length ? [...f.tags, ...own] : f.tags;
    // Corrections apply to the graph too, and they have to: a tag removed
    // because it was wrong must stop pulling that node into the wrong cluster,
    // or the correction is cosmetic.
    return ctx.overlay.removals.length ? all.filter((id) => !ctx.isRemoved(f.id, id)) : all;
  };

  if (mode === 'tags') {
    const graph = buildTagGraph(selected, tagById, tagIdsOf);
    return NextResponse.json({ mode, ...graph, label: describe(query) });
  }

  // The file graph is per-library: positions come from one precomputed layout,
  // so mixing two libraries' coordinate spaces would be meaningless.
  const libraryId = (query.libraryId
    ?? ctx.grants.find((g) => g.isPrimary)?.libraryId
    ?? ctx.grants[0]?.libraryId) as LibraryId | undefined;

  if (!libraryId) {
    return NextResponse.json({ error: 'no library granted' }, { status: 404 });
  }

  const full = await repo.getLibraryGraph(ctx, libraryId);
  if (!full) return NextResponse.json({ error: 'no graph' }, { status: 404 });

  const limitParam = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0
    ? Math.min(limitParam, MAX_FILE_NODES)
    : DEFAULT_FILE_NODES;

  const inThisLibrary = selected.filter((f) => f.libraryId === libraryId);
  const payload = induceFileGraph(inThisLibrary, full, tagById, tagIdsOf, limit);

  return NextResponse.json({ mode, ...payload, files: inThisLibrary.length, label: describe(query) });
}

function describe(query: { tags?: Record<string, string[]>; q?: string }): string {
  const parts: string[] = [];
  if (query.q) parts.push(`"${query.q}"`);
  for (const names of Object.values(query.tags ?? {})) {
    if (names.length) parts.push(names.join(' or '));
  }
  return parts.join(' · ');
}
