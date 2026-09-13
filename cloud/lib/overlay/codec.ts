import type { FileId, WorkspaceId } from '../data/types';
import { emptyOverlay, MAX_ADDITIONS, MAX_ALBUM_FILES, MAX_ALBUMS, MAX_REMOVALS } from './types';
import type { Album, Overlay } from './types';

/* The cookie encoding.
 *
 * Pure functions with no next/headers import, so the format can be tested in
 * plain Node (tests/verify.mjs) without booting a request context.
 *
 * Not JSON. A cookie value may not contain a comma, a semicolon, a double
 * quote, a backslash or whitespace (RFC 6265), so JSON has to be percent- or
 * base64-encoded, and both inflate a payload that is already fighting a 4 KB
 * ceiling -- base64 by a third, percent-encoding by more than that on the
 * braces and quotes. This format is already cookie-safe as written:
 *
 *   1 | r!<fileId>-<tagId base36>!... | t!<fileId>-<tagId base36>!... | a!<id>~<name>~<fileId>.<fileId>!...
 *
 * `t` (additions) was added after `r` and `a` shipped, and the VERSION did not
 * change. That is safe in both directions and deliberately so: the decoder
 * loops over sections and ignores a kind it does not recognise, so an old
 * cookie simply has no `t`, and a cookie written by this code and read by the
 * previous build loses its additions rather than being discarded whole. A
 * version bump would have thrown away every existing correction instead.
 *
 * Album names are the only free text, and they are percent-encoded, whose
 * output character set is cookie-safe by construction.
 */

const VERSION = '1';

export function encodeOverlay(overlay: Overlay): string {
  const parts = [VERSION];

  if (overlay.removals.length) {
    parts.push(
      'r' + overlay.removals.map((r) => `!${r.fileId}-${r.tagId.toString(36)}`).join(''),
    );
  }

  if (overlay.additions.length) {
    parts.push(
      't' + overlay.additions.map((a) => `!${a.fileId}-${a.tagId.toString(36)}`).join(''),
    );
  }

  if (overlay.albums.length) {
    parts.push(
      'a' + overlay.albums
        .map((a) => `!${a.id}~${encodeURIComponent(a.name)}~${a.fileIds.join('.')}`)
        .join(''),
    );
  }

  return parts.join('|');
}

export function decodeOverlay(raw: string | undefined, workspaceId: WorkspaceId): Overlay {
  const overlay = emptyOverlay(workspaceId);
  if (!raw) return overlay;

  // A cookie can arrive percent-encoded depending on who set it; decoding a
  // value with no escapes is a no-op, so this is safe either way.
  let text = raw;
  try {
    text = decodeURIComponent(raw);
  } catch {
    /* malformed escape -- use it raw */
  }

  const [version, ...sections] = text.split('|');
  // An unknown version is discarded rather than guessed at. Losing a viewer's
  // corrections on a format change is bad; misreading them as different
  // corrections is worse.
  if (version !== VERSION) return overlay;

  for (const section of sections) {
    const kind = section[0];
    const items = section.slice(1).split('!').filter(Boolean);

    if (kind === 'r' || kind === 't') {
      const into = kind === 'r' ? overlay.removals : overlay.additions;
      const cap = kind === 'r' ? MAX_REMOVALS : MAX_ADDITIONS;
      for (const item of items.slice(0, cap)) {
        const cut = item.lastIndexOf('-');
        if (cut <= 0) continue;
        const tagId = parseInt(item.slice(cut + 1), 36);
        if (!Number.isFinite(tagId)) continue;
        into.push({ fileId: item.slice(0, cut) as FileId, tagId });
      }
    } else if (kind === 'a') {
      for (const item of items.slice(0, MAX_ALBUMS)) {
        const [id, name, files] = item.split('~');
        if (!id) continue;
        overlay.albums.push({
          id,
          name: safeDecode(name ?? '') || 'Untitled album',
          fileIds: (files ?? '').split('.').filter(Boolean).slice(0, MAX_ALBUM_FILES) as FileId[],
          createdAt: 0, // not stored; the cookie is not a database
        });
      }
    }
  }

  return overlay;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Album ids only have to be unique within one cookie. */
export function newAlbumId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function findAlbum(overlay: Overlay, id: string): Album | undefined {
  return overlay.albums.find((a) => a.id === id);
}
