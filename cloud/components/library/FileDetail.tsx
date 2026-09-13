'use client';

import { useState, useTransition } from 'react';
import { Icon, TagIcon, iconForMedia } from '@/lib/icons';
import { formatBytes, formatDate } from '@/lib/format';
import { removeTag, restoreAllTags, restoreTag, toggleInAlbum } from '@/app/w/[ws]/actions';
import { FileInsight } from './FileInsight';
import type { FileView, TagView } from './LibraryBrowser';
import s from './detail.module.css';

export interface AlbumMembership {
  id: string;
  name: string;
  fileIds: string[];
}

/* The file panel: where a wrong tag gets corrected.
 *
 * Removal lives here rather than on the tile or the row for a reason worth
 * stating. An X on every chip in a 120-row list is 900 destructive controls a
 * stray click away from each other, and a mis-click has no visible
 * consequence -- the tag simply is not there any more, on a file you were not
 * looking at. Opening the file first makes the correction deliberate and gives
 * the undo somewhere to live.
 *
 * Removed tags stay on screen, struck through, with a restore. This is a lens
 * over a catalogue that was not changed, so the honest UI shows the tag still
 * exists and this workspace is choosing not to count it.
 *
 * The panel keeps its OWN copy of the file and moves tags between the two
 * lists itself, rather than re-reading the server list. Not for speed -- because
 * the server's next answer may not contain this file at all. Remove `Design`
 * while the library is filtered to `topic=design` and the file correctly stops
 * matching; a panel that re-read from that list would find nothing and close,
 * and the undo for the change just made would be gone with it.
 */
export function FileDetail({
  ws,
  file: initial,
  albums,
  canEdit,
  modelReady,
  onClose,
}: {
  ws: string;
  file: FileView;
  albums: AlbumMembership[];
  canEdit: boolean;
  modelReady: boolean;
  onClose: () => void;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<FileView>(initial);

  /* Membership is an OVERRIDE map, not a copy of `albums`. The album list
     itself stays the server's, so an album created in the sidebar while this
     panel is open appears in it; only the ticks this panel has changed are
     held locally, for the same reason the file is. */
  const [ticked, setTicked] = useState<Record<string, boolean>>({});

  /** Runs the action, applying `commit` to the local copy only if the server
   *  accepted it -- so a refusal (read-only grant, cookie full) leaves the
   *  panel showing what is actually stored, not what was attempted. */
  function run(
    fn: () => Promise<{ ok: boolean; error?: string }>,
    commit?: () => void,
  ) {
    setError(null);
    start(async () => {
      const result = await fn();
      if (result.ok) commit?.();
      else setError(result.error ?? 'That change was not saved. Try again.');
    });
  }

  const moveTag = (tag: TagView, to: 'removed' | 'tags') =>
    setFile((f) => (to === 'removed'
      ? { ...f, tags: f.tags.filter((t) => t.id !== tag.id), removed: [...f.removed, tag] }
      : { ...f, removed: f.removed.filter((t) => t.id !== tag.id), tags: [...f.tags, tag] }));

  return (
    <aside className={s.panel} aria-label={`Details for ${file.name}`}>
      <header className={s.head}>
        <Icon name={iconForMedia(file.mediaType)} size={18} className={s.headIcon} />
        <h2 className={s.title} title={file.relPath}>{file.name}</h2>
        <button type="button" className={s.close} onClick={onClose} aria-label="Close details">
          <Icon name="close" size={17} />
        </button>
      </header>

      <dl className={s.facts}>
        <div><dt>Kind</dt><dd>{file.kindLabel}</dd></div>
        <div><dt>Size</dt><dd>{formatBytes(file.sizeBytes)}</dd></div>
        <div><dt>Modified</dt><dd>{formatDate(file.mtime)}</dd></div>
        <div>
          <dt>Folder</dt>
          <dd className={s.path} title={file.parentRel}>{file.parentRel.replace(/\/$/, '')}</dd>
        </div>
      </dl>

      <section className={s.section}>
        <h3 className={s.sectionLabel}>
          Tags
          {file.removed.length > 0 && (
            <button
              type="button"
              className={s.textBtn}
              onClick={() => run(
                () => restoreAllTags(ws, file.id),
                () => setFile((f) => ({ ...f, tags: [...f.tags, ...f.removed], removed: [] })),
              )}
              disabled={pending}
            >
              <Icon name="undo" size={13} /> Restore all
            </button>
          )}
        </h3>

        <div className={s.tags}>
          {file.tags.map((tag) => (
            <span
              key={tag.id}
              className={tag.user ? s.tagUser : s.tag}
              title={`${tag.kind}: ${tag.name}`}
            >
              <TagIcon kind={tag.kind} name={tag.name} size={13} />
              {tag.display}
              {canEdit && (
                <button
                  type="button"
                  className={s.tagX}
                  onClick={() => run(
                    () => removeTag(ws, file.id, tag.id),
                    () => moveTag(tag, 'removed'),
                  )}
                  disabled={pending}
                  aria-label={`Remove the ${tag.display} tag from ${file.name}`}
                  title={`Not ${tag.display}`}
                >
                  <Icon name="close" size={12} />
                </button>
              )}
            </span>
          ))}
          {file.tags.length === 0 && (
            <span className={s.none}>
              No tags on this file. Nothing in it matched the classifier.
            </span>
          )}
        </div>

        {file.removed.length > 0 && (
          <>
            <h4 className={s.removedLabel}>
              <Icon name="visibility_off" size={12} /> Not counted in this workspace
            </h4>
            <div className={s.tags}>
              {file.removed.map((tag) => (
                <span key={tag.id} className={s.tagOff} title={`${tag.kind}: ${tag.name}`}>
                  <TagIcon kind={tag.kind} name={tag.name} size={13} />
                  <s>{tag.display}</s>
                  <button
                    type="button"
                    className={s.tagX}
                    onClick={() => run(
                      () => restoreTag(ws, file.id, tag.id),
                      () => moveTag(tag, 'tags'),
                    )}
                    disabled={pending}
                    aria-label={`Restore the ${tag.display} tag on ${file.name}`}
                    title={`Restore ${tag.display}`}
                  >
                    <Icon name="undo" size={12} />
                  </button>
                </span>
              ))}
            </div>
            <p className={s.note}>
              The catalogue still holds these. Removing a tag is this workspace&rsquo;s
              opinion, not an edit &mdash; other teams sharing the library are unaffected.
            </p>
          </>
        )}
      </section>

      {/* Below the tags, because the tags are the evidence both halves of it
          reason from, and above albums, because filing the file somewhere is
          the thing you do AFTER working out what it is. */}
      <FileInsight ws={ws} fileId={file.id} canExplain={modelReady} />

      {canEdit && (
        <section className={s.section}>
          <h3 className={s.sectionLabel}>Albums</h3>
          {albums.length === 0 ? (
            <p className={s.none}>Create an album in the sidebar first.</p>
          ) : (
            <ul className={s.albums}>
              {albums.map((album) => {
                const inIt = ticked[album.id] ?? album.fileIds.includes(file.id);
                return (
                  <li key={album.id}>
                    <label className={s.albumRow}>
                      <input
                        type="checkbox"
                        checked={inIt}
                        disabled={pending}
                        onChange={() => run(
                          () => toggleInAlbum(ws, album.id, file.id),
                          () => setTicked((t) => ({ ...t, [album.id]: !inIt })),
                        )}
                      />
                      <Icon name="photo_album" size={14} className={s.albumIcon} />
                      <span className={s.albumName}>{album.name}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {!canEdit && (
        <p className={s.note}>
          Your access to this workspace is read-only, so tags and albums cannot be
          changed here.
        </p>
      )}

      {error && <p className={s.error}>{error}</p>}
    </aside>
  );
}
