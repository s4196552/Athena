import { TAG_AXES } from '../taxonomy';
import type { FileQuery } from '../data/repository';
import type { LibraryId } from '../data/types';

/* URL parameters <-> a FileQuery.
 *
 * The parameter names are the desktop app's (athena/web/queries.py TAG_AXES),
 * so a link is portable between the local app and this one. The algebra is the
 * desktop app's too: OR within an axis, AND across axes. A repeated value
 * widens the selection; a second axis narrows it.
 */

const KINDS = TAG_AXES.map((a) => a.kind);

export function parseFilterParams(sp: URLSearchParams): FileQuery {
  const tags: Record<string, string[]> = {};
  for (const kind of KINDS) {
    const values = sp.getAll(kind).flatMap((v) => v.split(',')).filter(Boolean);
    if (values.length) tags[kind] = values;
  }

  /* The cursor is an offset into the filtered list. It is parsed rather than
     passed through so a hand-edited "?cursor=-5" or "?cursor=abc" cannot reach
     Array.slice, where a negative start counts from the END and would quietly
     serve the wrong page. */
  const offset = Number(sp.get('cursor'));
  const cursor = Number.isFinite(offset) && offset > 0
    ? String(Math.floor(offset))
    : undefined;

  return {
    tags: Object.keys(tags).length ? tags : undefined,
    q: sp.get('q')?.trim() || undefined,
    albumId: sp.get('album')?.trim() || undefined,
    mediaType: sp.get('type')?.trim() || undefined,
    libraryId: (sp.get('lib')?.trim() || undefined) as LibraryId | undefined,
    cursor,
  };
}

/** The inverse. Canonical ordering (axes in TAG_AXES order, values sorted) so
 *  the same selection always produces the same string -- which is what lets a
 *  saved view be compared, cached and shared.
 *
 *  `cursor` is deliberately NOT emitted. This string is the brief's cache key
 *  and the graph's filter, and both describe the whole selection: page three of
 *  a selection is the same selection, so including the offset would fragment
 *  the cache and hand the graph a parameter it has no use for. */
export function toSearchParams(query: FileQuery): URLSearchParams {
  const sp = new URLSearchParams();
  for (const kind of KINDS) {
    const values = query.tags?.[kind];
    if (values?.length) sp.set(kind, [...values].sort().join(','));
  }
  if (query.q) sp.set('q', query.q);
  if (query.albumId) sp.set('album', query.albumId);
  if (query.mediaType) sp.set('type', query.mediaType);
  if (query.libraryId) sp.set('lib', query.libraryId);
  return sp;
}

export function hasAnyFilter(query: FileQuery): boolean {
  return Boolean(
    query.q || query.mediaType || query.albumId || Object.keys(query.tags ?? {}).length,
  );
}
