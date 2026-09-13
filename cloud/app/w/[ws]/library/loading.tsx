import s from '@/components/shell/skeleton.module.css';

/* Shown while the library segment builds. The rail and the tile grid are drawn
 * at the sizes the real ones use, so the content replaces the blocks in place
 * instead of shifting the page under a reader who has already started
 * scanning. */

const CHIP_WIDTHS = [64, 88, 52, 96, 72, 60, 84, 56];

export default function LoadingLibrary() {
  return (
    <div className={s.layout} aria-busy="true" aria-label="Loading the library">
      <aside className={s.rail}>
        {[0, 1, 2, 3].map((group) => (
          <div key={group} className={s.railGroup}>
            <div className={`${s.bar} ${s.railLabel}`} />
            <div className={s.chips}>
              {CHIP_WIDTHS.map((width, i) => (
                <div key={i} className={`${s.bar} ${s.chip}`} style={{ width }} />
              ))}
            </div>
          </div>
        ))}
      </aside>

      <div className={s.main}>
        <div className={s.head}>
          <div className={`${s.bar} ${s.count}`} />
          <div className={s.spacer} />
          <div className={`${s.bar} ${s.button}`} />
          <div className={`${s.bar} ${s.button}`} />
        </div>
        <div className={s.grid}>
          {Array.from({ length: 18 }, (_, i) => (
            <div key={i}>
              <div className={`${s.bar} ${s.tile}`} />
              <div className={`${s.bar} ${s.caption}`} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
