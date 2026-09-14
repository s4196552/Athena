'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth';
import { workspaceContext } from '@/lib/data/context';
import { writeOverlay } from '@/lib/overlay/store';
import { newAlbumId } from '@/lib/overlay/codec';
import { MAX_ALBUM_FILES, MAX_ALBUMS, MAX_REMOVALS } from '@/lib/overlay/types';
import { getRepository } from '@/lib/data';
import { library } from '@/lib/data/json/load';
import { toFileView, type FileView } from '@/lib/data/view';
import type { Overlay } from '@/lib/overlay/types';
import type { FileId, TagId } from '@/lib/data/types';
import type { WorkspaceContext } from '@/lib/data/repository';

/* Writes to the overlay.
 *
 * Every action follows the same four steps, and the order matters:
 *
 *   1. requireSession   -- who is this
 *   2. workspaceContext -- may they enter this workspace at all (404 if not)
 *   3. ctx.can('tag')   -- is their effective permission enough to change it
 *   4. writeOverlay     -- which can still refuse on size
 *
 * Step 3 is the one that is easy to skip and expensive to skip. `can('tag')`
 * is min(workspace role, grant access), so a viewer, or anyone in a workspace
 * whose grant is read-only, gets a refusal here rather than a correction that
 * appears to work and is silently meaningless.
 *
 * File ids arrive as plain strings because that is what they are on the wire.
 * `visibleFile` is the second boundary where a branded FileId is minted (the
 * first is the JSON loader), and it earns the cast by looking the id up
 * through the repository -- which resolves it inside this workspace's grants,
 * so an id belonging to a library this workspace cannot see comes back null.
 */

export type ActionResult = { ok: true } | { ok: false; error: string };

/* Typed as the FAILURE shape rather than as ActionResult, so they are equally
   usable by anything returning a richer success -- `openFile` below returns a
   file on success and still refuses in the same words. */
const DENIED = {
  ok: false as const,
  error: 'You need contribute access in this workspace to change tags or albums.',
};
const GONE = { ok: false as const, error: 'That workspace is not available.' };
const NO_FILE = { ok: false as const, error: 'That file is not in this workspace.' };

async function visibleFile(ctx: WorkspaceContext, id: string): Promise<FileId | null> {
  const file = await getRepository().getFile(ctx, id as FileId);
  return file?.id ?? null;
}

async function withOverlay(
  ws: string,
  mutate: (overlay: Overlay, ctx: WorkspaceContext) => ActionResult | void | Promise<ActionResult | void>,
): Promise<ActionResult> {
  const session = await requireSession(`/w/${ws}/library`);
  const ctx = await workspaceContext(session.user.id, ws);
  if (!ctx) return GONE;
  if (!ctx.can('tag')) return DENIED;

  // Cloned, so a mutation that turns out to be refused cannot leave the
  // in-request context describing a state that was never written.
  const next: Overlay = {
    workspaceId: ctx.overlay.workspaceId,
    removals: [...ctx.overlay.removals],
    additions: [...ctx.overlay.additions],
    albums: ctx.overlay.albums.map((a) => ({ ...a, fileIds: [...a.fileIds] })),
  };

  const refusal = await mutate(next, ctx);
  if (refusal && !refusal.ok) return refusal;

  const written = await writeOverlay(next);
  if (!written.ok) return written;

  // The library page, the graph and the workspace summary all read through
  // tagIdsOf, so all three are stale after any removal.
  revalidatePath(`/w/${ws}`, 'layout');
  return { ok: true };
}

// --- tag corrections -------------------------------------------------------

export async function removeTag(
  ws: string,
  rawFileId: string,
  tagId: TagId,
): Promise<ActionResult> {
  return withOverlay(ws, async (o, ctx) => {
    const fileId = await visibleFile(ctx, rawFileId);
    if (!fileId) return NO_FILE;
    if (o.removals.some((r) => r.fileId === fileId && r.tagId === tagId)) return;
    if (o.removals.length >= MAX_REMOVALS) {
      return {
        ok: false,
        error: `This workspace has reached ${MAX_REMOVALS} tag corrections. `
          + 'Restore a few before removing more.',
      };
    }
    o.removals.push({ fileId, tagId });
  });
}

/* Restores need no visibility check. Dropping an entry from this workspace's
   own overlay is safe whatever the id is -- at worst it removes nothing. */
export async function restoreTag(
  ws: string,
  fileId: string,
  tagId: TagId,
): Promise<ActionResult> {
  return withOverlay(ws, (o) => {
    o.removals = o.removals.filter((r) => !(r.fileId === fileId && r.tagId === tagId));
  });
}

/** Undo every correction on one file. */
export async function restoreAllTags(ws: string, fileId: string): Promise<ActionResult> {
  return withOverlay(ws, (o) => {
    o.removals = o.removals.filter((r) => r.fileId !== fileId);
  });
}

// --- albums ----------------------------------------------------------------

export async function createAlbum(ws: string, rawName: string): Promise<ActionResult> {
  const name = rawName.trim().slice(0, 48);
  if (!name) return { ok: false, error: 'An album needs a name.' };

  return withOverlay(ws, (o) => {
    if (o.albums.length >= MAX_ALBUMS) {
      return { ok: false, error: `A workspace can hold ${MAX_ALBUMS} albums.` };
    }
    if (o.albums.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
      return { ok: false, error: `There is already an album called “${name}”.` };
    }
    o.albums.push({ id: newAlbumId(), name, fileIds: [], createdAt: Date.now() });
  });
}

export async function renameAlbum(
  ws: string,
  albumId: string,
  rawName: string,
): Promise<ActionResult> {
  const name = rawName.trim().slice(0, 48);
  if (!name) return { ok: false, error: 'An album needs a name.' };

  return withOverlay(ws, (o) => {
    const album = o.albums.find((a) => a.id === albumId);
    if (!album) return { ok: false, error: 'That album no longer exists.' };
    album.name = name;
  });
}

export async function deleteAlbum(ws: string, albumId: string): Promise<ActionResult> {
  return withOverlay(ws, (o) => {
    o.albums = o.albums.filter((a) => a.id !== albumId);
  });
}

/** Toggle one file's membership. One action rather than add/remove, because
 *  the control is a checkbox and a checkbox has one handler. */
export async function toggleInAlbum(
  ws: string,
  albumId: string,
  rawFileId: string,
): Promise<ActionResult> {
  return withOverlay(ws, async (o, ctx) => {
    const album = o.albums.find((a) => a.id === albumId);
    if (!album) return { ok: false, error: 'That album no longer exists.' };

    const fileId = await visibleFile(ctx, rawFileId);
    if (!fileId) return NO_FILE;

    if (album.fileIds.includes(fileId)) {
      album.fileIds = album.fileIds.filter((id) => id !== fileId);
      return;
    }
    if (album.fileIds.length >= MAX_ALBUM_FILES) {
      return {
        ok: false,
        error: `“${album.name}” holds the maximum ${MAX_ALBUM_FILES} files.`,
      };
    }
    album.fileIds.push(fileId);
  });
}


/* ---------------------------------------------------------------------------
 *  Reading one file, for a panel that is not on the library page.
 *
 *  The library ships every file it lists already flattened, so its panel needs
 *  no fetch. The graph cannot: it draws up to a few thousand dots and shipping
 *  a full record for each so that one of them might be clicked would be paying
 *  for the whole catalogue to answer a question about one file.
 *
 *  So the panel is the same component and the data arrives one file at a time.
 *  Read-only, and the only thing in this file that writes nothing.
 * ------------------------------------------------------------------------- */

export type OpenFileResult =
  | { ok: true; file: FileView }
  | { ok: false; error: string };

export async function openFile(ws: string, rawFileId: string): Promise<OpenFileResult> {
  const session = await requireSession(`/w/${ws}/graph`);
  const ctx = await workspaceContext(session.user.id, ws);
  if (!ctx) return GONE;

  /* Through the repository, so an id belonging to a library this workspace has
     no grant on comes back null -- the same boundary `visibleFile` relies on,
     and the reason a file id in a URL is not a way to read another tenant's
     catalogue. */
  const file = await getRepository().getFile(ctx, rawFileId as FileId);
  if (!file) return NO_FILE;

  /* The tag table for every library this workspace can see. Built per call
     rather than cached: `library()` is already memoised by the JSON loader, so
     this is a map build over data in memory, not a read. */
  const tagById = new Map<number, { kind: string; name: string; displayName: string }>();
  for (const id of new Set(ctx.grants.map((g) => g.libraryId))) {
    for (const t of library(id).tags) tagById.set(t.id, t);
  }

  return { ok: true, file: toFileView(ctx, file, tagById) };
}
