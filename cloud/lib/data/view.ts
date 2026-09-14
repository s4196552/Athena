import { lensedTags } from './lens';
import type { WorkspaceContext } from './repository';
import type { FileRecord } from './types';

/* One file, flattened for the panel that shows it.
 *
 * Deliberately not the full FileRecord: shipping tag ids to the browser would
 * mean shipping the tag table with them, and the panel needs names.
 *
 * This lived inside the library page until the graph needed the same panel.
 * Two copies of a mapper is how the two views start disagreeing about what a
 * file IS -- one resolving the doctype and the other not, one applying the
 * workspace's corrections and the other showing a tag it had already been
 * told was wrong. lib/data/lens.ts exists because exactly that happened once
 * already; this is the same lesson one level up.
 */

export interface TagView {
  id: number;
  kind: string;
  name: string;
  display: string;
  /** True for this workspace's own tags -- its user tags and the suggestions
   *  it accepted from the agent. Both are an opinion this team holds rather
   *  than a fact about the content, which is the distinction the UI marks. */
  user?: boolean;
}

export interface FileView {
  id: string;
  name: string;
  relPath: string;
  parentRel: string;
  ext: string;
  sizeBytes: number;
  mtime: number;
  mediaType: 'image' | 'video' | 'audio' | 'document' | 'other';
  /** Resolved doctype display, e.g. "Invoice". */
  kindLabel: string;
  /** Tags this workspace currently counts. */
  tags: TagView[];
  /** Tags this workspace has removed. Still in the catalogue, not counted
   *  here -- the panel shows them struck through so the undo has somewhere to
   *  live. */
  removed: TagView[];
  tintHex?: string;
}

/* A colour per media kind, for files the catalogue has no thumbnail tint for.
 * Not a tag colour and not the workspace accent: it answers "what sort of
 * thing is this" at a glance in a grid, which is a different question from
 * either of those. */
export const MEDIA_TINT: Record<string, string> = {
  image: '#3d5a80', video: '#5c4b73', audio: '#3f6b5a',
  document: '#6b5d3f', other: '#4a4a5e',
};

export function toFileView(
  ctx: WorkspaceContext,
  f: FileRecord,
  tagById: Map<number, { kind: string; name: string; displayName: string }>,
): FileView {
  const { tags, removed } = lensedTags(ctx, f, tagById);
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
}
