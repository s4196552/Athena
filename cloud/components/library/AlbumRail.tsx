'use client';

import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { Icon } from '@/lib/icons';
import { createAlbum, deleteAlbum, renameAlbum } from '@/app/w/[ws]/actions';
import s from './albums.module.css';
import { formatNumber } from '@/lib/format';

export interface AlbumView {
  id: string;
  name: string;
  count: number;
  /** Precomputed server-side so selecting an album keeps every other filter. */
  href: string;
  active: boolean;
}

/* Albums in the rail.
 *
 * A native <details> rather than a hand-rolled menu. It opens without
 * JavaScript, closes on Escape, is in the tab order, and is announced as a
 * disclosure by screen readers -- all of which a div with an onClick has to
 * reimplement, usually incompletely. The only scripted behaviour here is the
 * forms, which genuinely need it.
 *
 * It stays open when an album is selected, because the next thing a person
 * does after picking one is pick a different one.
 */
export function AlbumRail({
  ws,
  albums,
  clearHref,
  canEdit,
}: {
  ws: string;
  albums: AlbumView[];
  clearHref: string;
  canEdit: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  /* Deleting an album is the one destructive action in this app that had
     neither a confirmation nor an undo -- removing a TAG, which is reversible,
     offers both a per-tag restore and a "Restore all". An album is a set
     somebody assembled by hand and nothing rebuilds it, so it asks first. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const selected = albums.find((a) => a.active);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    start(async () => {
      const result = await fn();
      if (!result.ok) setError(result.error ?? 'That change was not saved. Try again.');
    });
  }

  return (
    <details className={s.wrap} open={Boolean(selected)}>
      <summary className={s.summary}>
        <Icon name="photo_album" size={15} />
        <span className={s.summaryLabel}>Albums</span>
        <span className={s.summaryValue}>
          {selected ? selected.name : `${albums.length || 'None'}`}
        </span>
        <Icon name="expand_more" size={16} className={s.chevron} />
      </summary>

      <div className={s.panel}>
        {albums.length === 0 && (
          <p className={s.empty}>
            No albums yet. An album is a set this workspace decided belongs
            together — the catalogue has no opinion about it.
          </p>
        )}

        <ul className={s.list}>
          {albums.map((album) => (
            <li key={album.id} className={album.active ? s.itemOn : s.item}>
              {confirming === album.id ? (
                <div className={s.confirm} role="group" aria-label={`Delete ${album.name}?`}>
                  <span className={s.confirmText}>Delete “{album.name}”?</span>
                  <button
                    type="button"
                    className={s.confirmYes}
                    onClick={() => { setConfirming(null); run(() => deleteAlbum(ws, album.id)); }}
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    className={s.confirmNo}
                    onClick={() => setConfirming(null)}
                    autoFocus
                  >
                    Keep
                  </button>
                </div>
              ) : renaming === album.id ? (
                <form
                  className={s.renameForm}
                  action={(data) => {
                    run(() => renameAlbum(ws, album.id, String(data.get('name') ?? '')));
                    setRenaming(null);
                  }}
                >
                  <input
                    name="name"
                    defaultValue={album.name}
                    className={s.input}
                    autoFocus
                    maxLength={48}
                    aria-label="Album name"
                  />
                  <button type="submit" className={s.iconBtn} title="Save">
                    <Icon name="check" size={15} />
                  </button>
                </form>
              ) : (
                <>
                  <Link href={album.href} className={s.link} scroll={false}>
                    <Icon
                      name={album.active ? 'check' : 'photo_album'}
                      size={14}
                      className={s.itemIcon}
                    />
                    <span className={s.itemName}>{album.name}</span>
                    <span className={s.itemCount}>{formatNumber(album.count)}</span>
                  </Link>
                  {canEdit && (
                    <span className={s.itemTools}>
                      <button
                        type="button"
                        className={s.iconBtn}
                        title={`Rename ${album.name}`}
                        onClick={() => setRenaming(album.id)}
                      >
                        <Icon name="edit" size={14} />
                      </button>
                      <button
                        type="button"
                        className={s.iconBtn}
                        title={`Delete ${album.name}`}
                        onClick={() => setConfirming(album.id)}
                      >
                        <Icon name="delete" size={14} />
                      </button>
                    </span>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>

        {selected && (
          <Link href={clearHref} className={s.clear} scroll={false}>
            <Icon name="close" size={13} /> Show the whole library
          </Link>
        )}

        {canEdit && (
          <form
            className={s.newForm}
            action={(data) => {
              run(() => createAlbum(ws, String(data.get('name') ?? '')));
              if (nameRef.current) nameRef.current.value = '';
            }}
          >
            <input
              ref={nameRef}
              name="name"
              className={s.input}
              placeholder="New album"
              maxLength={48}
              aria-label="New album name"
            />
            <button type="submit" className={s.iconBtn} disabled={pending} title="Create album">
              <Icon name="add" size={16} />
            </button>
          </form>
        )}

        {error && <p className={s.error}>{error}</p>}

        {/* Said plainly rather than discovered later. */}
        <p className={s.note}>Albums are saved in this browser, not shared with the workspace.</p>
      </div>
    </details>
  );
}
