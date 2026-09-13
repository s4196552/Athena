import type { FileId, TagId, WorkspaceId } from '../data/types';

/* THE OVERLAY: per-workspace corrections and collections.
 *
 * Why an overlay and not an edit.
 *
 * `Library.mutations` is typed `0` and the Python engine's whole promise is
 * that it never writes to what it indexed. A machine tag is a fact about
 * content -- `doctype=invoice` is true for every workspace that holds a grant
 * on that library, which is exactly why two teams sharing a catalogue see one
 * dataset rather than two.
 *
 * So "this file is not Design" cannot delete the tag. It is an OPINION THIS
 * WORKSPACE HOLDS about the catalogue, and it is stored the same way user tags
 * already are: attached to a workspace, applied as a lens at read time. The
 * catalogue is untouched; Marketing's correction does not silently rewrite
 * what Finance sees, which would be the worse bug of the two.
 *
 * An album is the same idea pointed the other way: a set this workspace has
 * decided belongs together, which the catalogue has no opinion about.
 */

/** One suppressed (file, tag) pair. */
export interface TagRemoval {
  fileId: FileId;
  tagId: TagId;
}

export interface Album {
  id: string;
  name: string;
  fileIds: FileId[];
  createdAt: number;
}

export interface Overlay {
  workspaceId: WorkspaceId;
  removals: TagRemoval[];
  albums: Album[];
}

/* Caps. A cookie is 4096 bytes including its name and attributes, and going
 * over does not error -- the browser silently drops the whole cookie, losing
 * every correction the viewer made. So the write path refuses instead, with a
 * message, and these keep it from getting near the edge in normal use. */
export const MAX_COOKIE_BYTES = 3800;
export const MAX_REMOVALS = 400;
export const MAX_ALBUMS = 20;
export const MAX_ALBUM_FILES = 250;

export function emptyOverlay(workspaceId: WorkspaceId): Overlay {
  return { workspaceId, removals: [], albums: [] };
}

/** Set of removed tag ids for one file. Built once per request by the caller
 *  that needs it, because the alternative is a linear scan per file per tag. */
export function removalIndex(overlay: Overlay): Map<string, Set<number>> {
  const index = new Map<string, Set<number>>();
  for (const r of overlay.removals) {
    let set = index.get(r.fileId);
    if (!set) index.set(r.fileId, (set = new Set()));
    set.add(r.tagId);
  }
  return index;
}
