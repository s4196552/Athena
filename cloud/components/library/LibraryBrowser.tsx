'use client';

import { useMemo } from 'react';
import { useLocalSetting } from '@/lib/useLocalSetting';
import { formatBytes, formatDate } from '@/lib/format';
import s from './browser.module.css';

/** Everything the browser needs, flattened server-side. Deliberately not the
 *  full FileRecord: tag ids would mean shipping a tag table too, for a column
 *  that only ever shows one resolved string. */
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
  kind: string;
  /** This workspace's own tags on this file. */
  userTags: string[];
  tintHex?: string;
}

type ViewMode = 'auto' | 'grid' | 'list';

/* Tile widths for the size slider, in px. Five stops rather than a continuous
 * range: a continuous one invites fiddling and every intermediate value looks
 * like a mistake, where discrete stops always land on a tidy grid. */
const TILE_SIZES = [96, 128, 168, 220, 300];

const MEDIA = new Set(['image', 'video']);

export function LibraryBrowser({ files, accent }: { files: FileView[]; accent: string }) {
  const [mode, setMode] = useLocalSetting<ViewMode>('athena:view', 'auto');
  const [size, setSize] = useLocalSetting<number>('athena:tile', 2);

  const tile = TILE_SIZES[Math.min(Math.max(size, 0), TILE_SIZES.length - 1)];

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
    <>
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
              Photos &amp; video <span className={s.sectionCount}>{media.length.toLocaleString()}</span>
            </h2>
          )}
          <div
            className={s.grid}
            style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tile}px, 1fr))` }}
          >
            {media.map((f) => (
              <article key={f.id} className={s.card}>
                <div className={s.thumb} style={{ background: f.tintHex ?? '#3d5a80' }}>
                  <span className={s.ext}>{f.ext}</span>
                </div>
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
              Documents &amp; other <span className={s.sectionCount}>{rest.length.toLocaleString()}</span>
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
                  <tr key={f.id}>
                    <td className={s.colName}>
                      <span className={s.rowName} title={f.relPath}>
                        <span className={s.badge} style={{ background: f.tintHex ?? '#4a4a5e' }}>
                          {f.ext}
                        </span>
                        {f.name}
                      </span>
                      {f.userTags.length > 0 && (
                        <span className={s.rowTags}>
                          {f.userTags.map((t) => (
                            <span key={t} className={s.userTag} style={{ color: accent }}>{t}</span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className={s.colKind}>{f.kind}</td>
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
    </>
  );
}
