import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { getRepository } from '@/lib/data';
import { library } from '@/lib/data/json/load';
import { ColorGroupsEditor } from './ColorGroupsEditor';
import type { GraphMode, TagKind, TagRecord, FileRecord } from '@/lib/data/types';
import s from './colors.module.css';

export const dynamic = 'force-dynamic';

const PREVIEW_SIZE = 300;

export default async function ColorsPage({
  params,
  searchParams,
}: {
  params: Promise<{ ws: string }>;
  searchParams: Promise<{ mode?: string }>;
}) {
  const { ws } = await params;
  const { mode: rawMode } = await searchParams;
  const mode: GraphMode = rawMode === 'tags' ? 'tags' : 'files';

  const session = await requireSession(`/w/${ws}/settings/colors`);
  const repo = getRepository();
  const ctx = await repo.buildContext(session.user.id, ws);
  if (!ctx) notFound();

  const groups = await repo.getColorGroups(ctx, mode);

  const tagById = new Map<number, TagRecord>();
  for (const id of new Set(ctx.grants.map((g) => g.libraryId))) {
    for (const t of library(id).tags) tagById.set(t.id, t);
  }

  const tagIdsOf = (f: FileRecord): number[] => {
    const own = f.userTags?.filter((u) => u.workspaceId === ctx.workspace.id).map((u) => u.tagId);
    return own?.length ? [...f.tags, ...own] : f.tags;
  };

  // A sample big enough to show the colour balance, small enough to ship.
  // Evenly spaced rather than the first N, so it is representative.
  const page = await repo.listFiles(ctx, { limit: Number.MAX_SAFE_INTEGER });
  const stride = Math.max(1, Math.floor(page.files.length / PREVIEW_SIZE));
  const sampled = page.files.filter((_, i) => i % stride === 0).slice(0, PREVIEW_SIZE);

  const slot = new Map<number, number>();
  const tagTable: { kind: TagKind; name: string }[] = [];
  const preview = sampled.map((f) => {
    const tags: number[] = [];
    for (const id of tagIdsOf(f)) {
      const t = tagById.get(id);
      if (!t) continue;
      let idx = slot.get(id);
      if (idx === undefined) {
        idx = tagTable.length;
        slot.set(id, idx);
        tagTable.push({ kind: t.kind, name: t.name });
      }
      tags.push(idx);
    }
    return {
      tags, name: f.name, path: f.relPath, ext: f.ext, mediaType: f.mediaType,
    };
  });

  // Shorthand suggestions, most-used first.
  const facets = await repo.facets(ctx, {});
  const suggestions = facets.flatMap((g) =>
    g.values.slice(0, 8).map((v) => `${g.kind}:${v.name}`));

  return (
    <div className={s.page}>
      <div className={s.pageHead}>
        <div>
          <h1 className={s.h1}>Graph colours — {ctx.workspace.name}</h1>
          <p className={s.sub}>
            Colours belong to this workspace, not to the library. {ctx.org.name}&rsquo;s
            other teams share the same catalogue and colour it their own way.
          </p>
        </div>
        <div className={s.modeSwitch}>
          <Link href={`/w/${ws}/settings/colors?mode=files`} className={mode === 'files' ? s.modeOn : s.modeOff}>Files</Link>
          <Link href={`/w/${ws}/settings/colors?mode=tags`} className={mode === 'tags' ? s.modeOn : s.modeOff}>Tags</Link>
        </div>
      </div>

      <ColorGroupsEditor
        ws={ws}
        mode={mode}
        initial={groups?.rules ?? []}
        tagTable={tagTable}
        preview={preview}
        suggestions={suggestions}
      />
    </div>
  );
}
