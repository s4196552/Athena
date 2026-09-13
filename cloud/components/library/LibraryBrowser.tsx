'use client';

import { useMemo, useState } from 'react';
import { useLocalSetting } from '@/lib/useLocalSetting';
import { formatBytes, formatDate, formatNumber } from '@/lib/format';
import { Icon, TagIcon, iconForMedia } from '@/lib/icons';
import { FileDetail, type AlbumMembership } from './FileDetail';
import s from './browser.module.css';

/** One tag as the browser needs it: resolved to a display string, but keeping
 *  kind and name because the icon lookup is keyed on `kind:name`. */
export interface TagView {
  id: number;
  kind: string;
  name: string;
  display: string;
  /** True for this workspace's own tags (asset_tag.source = 'user'). */
  user?: boolean;
}

/** Everything the browser needs, flattened server-side. Deliberately not the
 *  full FileRecord: shipping tag ids would mean shipping the tag table too. */
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
  /** Tags this workspace has removed. Still in the catalogue, not counted here. */
  removed: TagView[];
  tintHex?: string;
}

type ViewMode = 'auto' | 'grid' | 'list';

/* Tile widths for the size slider, in px. Five stops rather than a continuous
 * range: a continuous one invites fiddling and every intermediate value looks
 * like a mistake, where discrete stops always land on a tidy grid. */
const TILE_SIZES = [96, 128, 168, 220, 300];

const MEDIA = new Set(['image', 'video']);

/** Chips shown inline on a row. The rest are a click away in the panel --
 *  eight chips per row across 120 rows is a wall, not information. */
const ROW_TAG_LIMIT = 3;

export function LibraryBrowser({
  files,
  accent,
  ws,
  albums,
  canEdit,
}: {
  files: FileView[];
  accent: string;
  ws: string;
  albums: AlbumMembership[];
  canEdit: boolean;
}) {
  const [mode, setMode] = useLocalSetting<ViewMode>('athena:view', 'auto');
  const [size, setSize] = useLocalSetting<number>('athena:tile', 2);
  const [open, setOpen] = useState<FileView | null>(null);
  const openId = open?.id ?? null;

  const tile = TILE_SIZES[Math.min(Math.max(size, 0), TILE_SIZES.length - 1)];

  /* The open file is held as a VALUE, not looked up by id in `files` each
     render, and that is not an accident.
     
     Removing a tag while filtered by that tag is the single most common way
     this feature gets used -- "show me everything tagged Design, find the ones
     that are not" -- and the moment the correction lands, the file stops
     matching and the server drops it from the page. Looking the id up would
     then resolve to nothing: the panel would vanish mid-click, taking the undo
     with it, exactly when you most want the undo. So the panel owns its copy
     for as long as it is open, and applies each change to it itself. */

  /* Auto is the default because it matches what the files actually are. A
     spreadsheet has no thumbnail worth 220 pixels -- rendering it as a tile
     wastes a screenful to show a coloured rectangle and a truncated name,
     where a row shows its kind, size, date and tags at a glance. Photographs
     are the opposite: the picture IS the identifying information. */
  const { media, rest } = useMemo(() => {
    if (mode === 'grid') return { media: files, rest: [] as FileView[] };
    if (mode === 'list') return { media: [] as FileView[], rest: files };
    return {
      media: files.filter((f) => MEDIA.has(f.mediaType)),
      rest: files.filter((f) => !MEDIA.has(f.mediaType)),
    };
  }, [files, mode]);

  return (
    /* Padded, not overlaid, while the panel is open: a fixed panel laid over
       the grid hides a whole column of tiles, and the one it hides is the one
       next to the thing you just clicked. */
    <div className={open ? s.shifted : undefined}>
      <div className={s.controls}>
        <div className={s.modes} role="group" aria-label="View">
          {(['auto', 'grid', 'list'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`${s.mode} ${mode === m ? s.modeOn : ''}`}
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
            >
              <Icon
                name={m === 'auto' ? 'auto_awesome' : m === 'grid' ? 'grid_view' : 'view_list'}
                size={14}
              />
              {m === 'auto' ? 'Auto' : m === 'grid' ? 'Grid' : 'List'}
            </button>
          ))}
        </div>

        {/* Only meaningful when tiles are on screen. Disabled rather than
            hidden, so the control does not jump around as you switch view. */}
        <label className={s.sizer} title="Thumbnail size">
          <span className={s.sizeIcon} aria-hidden="true">▪</span>
          <input
            type="range"
            min={0}
            max={TILE_SIZES.length - 1}
            step={1}
            value={size}
            disabled={media.length === 0}
            onChange={(e) => setSize(Number(e.target.value))}
            aria-label="Thumbnail size"
            style={{ accentColor: accent }}
          />
          <span className={s.sizeIconLarge} aria-hidden="true">▪</span>
        </label>
      </div>

      {media.length > 0 && (
        <>
          {mode === 'auto' && rest.length > 0 && (
            <h2 className={s.sectionLabel}>
              Photos &amp; video <span className={s.sectionCount}>{formatNumber(media.length)}</span>
            </h2>
          )}
          <div
            className={s.grid}
            style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tile}px, 1fr))` }}
          >
            {media.map((f) => (
              <article key={f.id} className={s.card}>
                <button
                  type="button"
                  className={`${s.thumb} ${openId === f.id ? s.thumbOn : ''}`}
                  style={{ background: f.tintHex ?? '#3d5a80' }}
                  onClick={() => setOpen(f)}
                  aria-label={`Details for ${f.name}`}
                >
                  <span className={s.ext}>{f.ext}</span>
                  {f.removed.length > 0 && (
                    <span className={s.fixed} title="This workspace has corrected a tag here">
                      <Icon name="visibility_off" size={11} />
                    </span>
                  )}
                </button>
                <h3 className={s.name} title={f.relPath}>{f.name}</h3>
                {tile >= 128 && (
                  <p className={s.meta}>{formatBytes(f.sizeBytes)}</p>
                )}
              </article>
            ))}
          </div>
        </>
      )}

      {rest.length > 0 && (
        <>
          {mode === 'auto' && media.length > 0 && (
            <h2 className={s.sectionLabel}>
              Documents &amp; other <span className={s.sectionCount}>{formatNumber(rest.length)}</span>
            </h2>
          )}
          <div className={s.listWrap}>
            <table className={s.list}>
              <thead>
                <tr>
                  <th className={s.colName}>Name</th>
                  <th className={s.colKind}>Kind</th>
                  <th className={s.colSize}>Size</th>
                  <th className={s.colDate}>Modified</th>
                  <th className={s.colWhere}>Folder</th>
                </tr>
              </thead>
              <tbody>
                {rest.map((f) => (
                  <tr
                    key={f.id}
                    className={openId === f.id ? s.rowOn : undefined}
                    onClick={() => setOpen(f)}
                  >
                    <td className={s.colName}>
                      <span className={s.rowName} title={f.relPath}>
                        <span className={s.badge} style={{ background: f.tintHex ?? '#4a4a5e' }}>
                          <Icon name={iconForMedia(f.mediaType)} size={12} />
                        </span>
                        <span>{f.name}</span>
                      </span>
                      {f.tags.length > 0 && (
                        <span className={s.rowTags}>
                          {f.tags.slice(0, ROW_TAG_LIMIT).map((t) => (
                            <span
                              key={t.id}
                              className={t.user ? s.userTag : s.machineTag}
                              style={t.user ? { color: accent } : undefined}
                            >
                              <TagIcon kind={t.kind} name={t.name} size={11} />
                              {t.display}
                            </span>
                          ))}
                          {f.tags.length > ROW_TAG_LIMIT && (
                            <span className={s.moreTags}>
                              +{f.tags.length - ROW_TAG_LIMIT}
                            </span>
                          )}
                          {f.removed.length > 0 && (
                            <span
                              className={s.correctedTag}
                              title={`${f.removed.length} tag(s) removed in this workspace`}
                            >
                              <Icon name="visibility_off" size={11} />
                              {f.removed.length}
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                    <td className={s.colKind}>
                      <span className={s.kindCell}>
                        <Icon name={iconForMedia(f.mediaType)} size={13} className={s.kindIcon} />
                        {f.kindLabel}
                      </span>
                    </td>
                    <td className={s.colSize}>{formatBytes(f.sizeBytes)}</td>
                    <td className={s.colDate}>{formatDate(f.mtime)}</td>
                    <td className={s.colWhere} title={f.parentRel}>
                      {f.parentRel.replace(/\/$/, '')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {open && (
        <FileDetail
          key={open.id}
          ws={ws}
          file={open}
          albums={albums}
          canEdit={canEdit}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
