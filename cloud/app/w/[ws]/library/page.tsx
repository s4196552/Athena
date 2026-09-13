import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { workspaceContext } from '@/lib/data/context';
import { getRepository } from '@/lib/data';
import { parseFilterParams, toSearchParams, hasAnyFilter } from '@/lib/filter/params';
import { PAGE_SIZE } from '@/lib/data/repository';
import { formatCount, formatNumber } from '@/lib/format';
import { library } from '@/lib/data/json/load';
import { TagIcon, Icon } from '@/lib/icons';
import { LibraryBrowser, type FileView, type TagView } from '@/components/library/LibraryBrowser';
import { AlbumRail, type AlbumView } from '@/components/library/AlbumRail';
import { BriefPanel } from '@/components/library/BriefPanel';
import { SearchBox } from '@/components/library/SearchBox';
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

  // workspaceContext, not repo.buildContext: this is the call that carries the
  // workspace's tag corrections and albums into every query below.
  const ctx = await workspaceContext(session.user.id, ws);
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

  const tagById = new Map<number, { kind: string; name: string; displayName: string }>();
  for (const id of new Set(ctx.grants.map((g) => g.libraryId))) {
    for (const t of library(id).tags) tagById.set(t.id, t);
  }

  function href(next: URLSearchParams): string {
    /* Any change to WHAT is selected returns to the first page. Keeping the
       offset would land someone on "showing 241-360 of 118" -- an empty screen
       that looks like the filter found nothing. */
    next.delete('cursor');
    const qs = next.toString();
    return `/w/${ws}/library${qs ? `?${qs}` : ''}`;
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
    return href(next);
  }

  /** Selecting an album narrows the current selection rather than replacing
   *  it, so "Design files in the Brand refresh album" is one click from
   *  either direction. */
  function albumHref(id: string | null): string {
    const next = new URLSearchParams(usp);
    if (id) next.set('album', id);
    else next.delete('album');
    return href(next);
  }

  /** Dropping the search term alone. Until there was a way to set `q` there was
   *  no way to clear it either, short of "Clear", which discarded every facet
   *  with it. */
  function withoutQuery(): string {
    const next = new URLSearchParams(usp);
    next.delete('q');
    return href(next);
  }

  /** Paging keeps the selection and moves only the offset. */
  function pageHref(offset: number): string {
    const next = new URLSearchParams(usp);
    next.delete('cursor');
    const qs = next.toString();
    const cursor = offset > 0 ? `cursor=${offset}` : '';
    const joined = [qs, cursor].filter(Boolean).join('&');
    return `/w/${ws}/library${joined ? `?${joined}` : ''}`;
  }

  /* The filter minus the two things a new search must not inherit: the previous
     term, and the page it was being read at. */
  const preserve = [...toSearchParams(query).entries()].filter(([k]) => k !== 'q');

  const start = Number(query.cursor ?? 0);
  const shown = page.files.length;

  const active = Object.entries(query.tags ?? {}).flatMap(([kind, names]) =>
    names.map((name) => ({ kind, name })));

  const albums: AlbumView[] = ctx.overlay.albums.map((a) => ({
    id: a.id,
    name: a.name,
    count: a.fileIds.length,
    href: albumHref(a.id === query.albumId ? null : a.id),
    active: a.id === query.albumId,
  }));
  const openAlbum = ctx.overlay.albums.find((a) => a.id === query.albumId);

  /* Flattened for the client component. Resolving tags to display strings here
     means the browser receives what it draws instead of tag ids plus a tag
     table it would have to join against.

     `removed` is built from ctx.isRemoved rather than by diffing: the panel has
     to show a suppressed tag in order to offer the undo, and the repository
     has already dropped it from everything else. */
  const views: FileView[] = page.files.map((f) => {
    const own = (f.userTags ?? [])
      .filter((u) => u.workspaceId === ctx.workspace.id)
      .map((u) => u.tagId);

    const tags: TagView[] = [];
    const removed: TagView[] = [];
    for (const id of [...f.tags, ...own]) {
      const t = tagById.get(id);
      if (!t) continue;
      const view: TagView = {
        id, kind: t.kind, name: t.name, display: t.displayName, user: own.includes(id),
      };
      (ctx.isRemoved(f.id, id) ? removed : tags).push(view);
    }

    const doctype = tags.find((t) => t.kind === 'doctype');
    return {
      id: f.id,
      name: f.name,
      relPath: f.relPath,
      parentRel: f.parentRel,
      ext: f.ext,
      sizeBytes: f.sizeBytes,
      mtime: f.mtime,
      mediaType: f.mediaType,
      kindLabel: doctype?.display ?? f.mediaType,
      tags,
      removed,
      tintHex: f.tintHex ?? MEDIA_TINT[f.mediaType],
    };
  });

  return (
    <div className={s.layout}>
      {/* The rail's axes and their order come from TAG_AXES in
          athena/web/queries.py, so the two apps present the same vocabulary in
          the same order. Albums sit above them because they are a selection a
          person made, not a facet the engine derived. */}
      <aside className={s.rail}>
        <AlbumRail
          ws={ws}
          albums={albums}
          clearHref={albumHref(null)}
          canEdit={ctx.can('tag')}
        />

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
                    <TagIcon kind={group.kind} name={v.name} size={13} />
                    {v.display}
                    <span className={s.chipCount}>{formatNumber(v.count)}</span>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
      </aside>

      <main className={s.main} id="main">
        <div className={s.head}>
          <p className={s.count}>
            {formatCount(page.total, 'item')}
            {openAlbum ? ` in “${openAlbum.name}”` : ''}
            {query.q ? ` matching “${query.q}”` : ''}
          </p>
          <div className={s.spacer} />
          <SearchBox ws={ws} preserve={preserve} q={query.q} />
          {/* Summarises THIS selection, so the filter in the URL is the input.
              Serialised canonically so the same selection is one cache key. */}
          <BriefPanel ws={ws} query={toSearchParams(query).toString()} />
          <Link href={`/w/${ws}/graph?${toSearchParams(query)}`} className={s.linkBtn}>
            <Icon name="hub" size={14} /> View as graph
          </Link>
          {hasAnyFilter(query) && (
            <Link href={`/w/${ws}/library`} className={s.linkBtn}>
              <Icon name="close" size={14} /> Clear
            </Link>
          )}
        </div>

        {(active.length > 0 || openAlbum || query.q) && (
          <div className={s.active}>
            {query.q && (
              <Link href={withoutQuery()} className={s.activeChip}>
                <Icon name="search" size={12} />
                {query.q} <span aria-hidden="true">×</span>
              </Link>
            )}
            {openAlbum && (
              <Link href={albumHref(null)} className={s.activeChip} scroll={false}>
                <Icon name="photo_album" size={12} />
                {openAlbum.name} <span aria-hidden="true">×</span>
              </Link>
            )}
            {active.map(({ kind, name }) => (
              <Link key={`${kind}:${name}`} href={toggleHref(kind, name)} className={s.activeChip}>
                <TagIcon kind={kind} name={name} size={12} />
                {name} <span aria-hidden="true">×</span>
              </Link>
            ))}
          </div>
        )}

        {page.files.length === 0 ? (
          <p className={s.empty}>
            {openAlbum && page.total === 0 && openAlbum.fileIds.length === 0
              ? `“${openAlbum.name}” is empty. Open a file and tick this album to add it.`
              : hasAnyFilter(query)
                ? 'Nothing matches all of these filters. Remove one of the chips above to widen the selection.'
                : 'There are no files in this workspace’s share of the catalogue yet.'}
          </p>
        ) : (
          <LibraryBrowser
            files={views}
            accent={ctx.workspace.accentHex}
            ws={ws}
            albums={ctx.overlay.albums.map((a) => ({
              id: a.id, name: a.name, fileIds: a.fileIds,
            }))}
            canEdit={ctx.can('tag')}
          />
        )}

        {/* This used to be the sentence "Showing the first 120 of 2,971." with
            no control beside it, which made files 121 onwards unreachable by
            clicking. The repository has always returned a usable nextCursor. */}
        {(start > 0 || page.nextCursor) && shown > 0 && (
          <nav className={s.pager} aria-label="Pages">
            <p className={s.pagerCount}>
              {formatNumber(start + 1)}–{formatNumber(start + shown)} of{' '}
              {formatNumber(page.total)}
            </p>
            <div className={s.pagerButtons}>
              {start > 0 ? (
                <Link href={pageHref(Math.max(0, start - PAGE_SIZE))} className={s.pagerBtn}>
                  <Icon name="chevron_left" size={14} /> Previous
                </Link>
              ) : (
                <span className={`${s.pagerBtn} ${s.pagerOff}`} aria-hidden="true">
                  <Icon name="chevron_left" size={14} /> Previous
                </span>
              )}
              {page.nextCursor ? (
                <Link href={pageHref(start + PAGE_SIZE)} className={s.pagerBtn}>
                  Next <Icon name="chevron_right" size={14} />
                </Link>
              ) : (
                <span className={`${s.pagerBtn} ${s.pagerOff}`} aria-hidden="true">
                  Next <Icon name="chevron_right" size={14} />
                </span>
              )}
            </div>
          </nav>
        )}
      </main>
    </div>
  );
}
