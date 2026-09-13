import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { getRepository } from '@/lib/data';
import { parseFilterParams, toSearchParams, hasAnyFilter } from '@/lib/filter/params';
import { formatCount } from '@/lib/format';
import { library } from '@/lib/data/json/load';
import { LibraryBrowser, type FileView } from '@/components/library/LibraryBrowser';
import s from './library.module.css';

export const dynamic = 'force-dynamic';

const MEDIA_TINT: Record<string, string> = {
  image: '#3d5a80', video: '#5c4b73', audio: '#3f6b5a',
  document: '#6b5d3f', other: '#4a4a5e',
};

export default async function LibraryPage({
  params,
  searchParams,
}: {
  params: Promise<{ ws: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ws } = await params;
  const sp = await searchParams;
  const session = await requireSession(`/w/${ws}/library`);
  const repo = getRepository();

  const ctx = await repo.buildContext(session.user.id, ws);
  if (!ctx) notFound();

  // Rebuild a URLSearchParams so the same parser serves the page and the API.
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (Array.isArray(v)) v.forEach((x) => usp.append(k, x));
    else if (v !== undefined) usp.append(k, v);
  }
  const query = parseFilterParams(usp);

  const [page, facets] = await Promise.all([
    repo.listFiles(ctx, query),
    repo.facets(ctx, query),
  ]);

  const tagById = new Map<number, { kind: string; displayName: string }>();
  for (const id of new Set(ctx.grants.map((g) => g.libraryId))) {
    for (const t of library(id).tags) tagById.set(t.id, t);
  }

  /** Toggling a value keeps the rest of the filter intact, which is what makes
   *  the rail feel like refinement rather than navigation. */
  function toggleHref(kind: string, name: string): string {
    const next = new URLSearchParams(usp);
    const current = next.get(kind)?.split(',').filter(Boolean) ?? [];
    const updated = current.includes(name)
      ? current.filter((x) => x !== name)
      : [...current, name];
    if (updated.length) next.set(kind, updated.join(','));
    else next.delete(kind);
    const qs = next.toString();
    return `/w/${ws}/library${qs ? `?${qs}` : ''}`;
  }

  const active = Object.entries(query.tags ?? {}).flatMap(([kind, names]) =>
    names.map((name) => ({ kind, name })));

  /* Flattened for the client component. Resolving the doctype and the user
     tags here means the browser receives one string per column instead of tag
     ids plus a tag table it would have to join against. */
  const views: FileView[] = page.files.map((f) => {
    const doctype = f.tags
      .map((id) => tagById.get(id))
      .find((t) => t?.kind === 'doctype');
    return {
      id: f.id,
      name: f.name,
      relPath: f.relPath,
      parentRel: f.parentRel,
      ext: f.ext,
      sizeBytes: f.sizeBytes,
      mtime: f.mtime,
      mediaType: f.mediaType,
      kind: doctype?.displayName ?? f.mediaType,
      userTags: (f.userTags ?? [])
        .filter((u) => u.workspaceId === ctx.workspace.id)
        .map((u) => tagById.get(u.tagId)?.displayName ?? '')
        .filter(Boolean),
      tintHex: f.tintHex ?? MEDIA_TINT[f.mediaType],
    };
  });

  return (
    <div className={s.layout}>
      {/* The rail's axes and their order come from TAG_AXES in
          athena/web/queries.py, so the two apps present the same vocabulary in
          the same order. */}
      <aside className={s.rail}>
        {facets.map((group) => (
          <section key={group.kind} className={s.group}>
            <h2 className={s.groupLabel}>{group.label}</h2>
            <div className={s.chips}>
              {group.values.map((v) => {
                const on = query.tags?.[group.kind]?.includes(v.name) ?? false;
                return (
                  <Link
                    key={v.tagId}
                    href={toggleHref(group.kind, v.name)}
                    className={`${s.chip} ${on ? s.chipOn : ''}`}
                    scroll={false}
                  >
                    {v.display}
                    <span className={s.chipCount}>{v.count.toLocaleString()}</span>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
      </aside>

      <main className={s.main}>
        <div className={s.head}>
          <p className={s.count}>
            {formatCount(page.total, 'item')}
            {query.q ? ` matching “${query.q}”` : ''}
          </p>
          <div className={s.spacer} />
          <Link href={`/w/${ws}/graph?${toSearchParams(query)}`} className={s.linkBtn}>
            View as graph →
          </Link>
          {hasAnyFilter(query) && (
            <Link href={`/w/${ws}/library`} className={s.linkBtn}>Clear</Link>
          )}
        </div>

        {active.length > 0 && (
          <div className={s.active}>
            {active.map(({ kind, name }) => (
              <Link key={`${kind}:${name}`} href={toggleHref(kind, name)} className={s.activeChip}>
                {name} <span aria-hidden="true">×</span>
              </Link>
            ))}
          </div>
        )}

        {page.files.length === 0 ? (
          <p className={s.empty}>
            Nothing matches. {hasAnyFilter(query) ? 'Try removing a filter.' : ''}
          </p>
        ) : (
          <LibraryBrowser files={views} accent={ctx.workspace.accentHex} />
        )}

        {page.nextCursor && (
          <p className={s.more}>
            Showing the first {page.files.length.toLocaleString()} of{' '}
            {page.total.toLocaleString()}.
          </p>
        )}
      </main>
    </div>
  );
}
