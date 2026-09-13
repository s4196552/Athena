/* Formatting that must not depend on where the code is running.
 *
 * These render on the SERVER first and are then hydrated in a BROWSER, and the
 * two do not agree about time or language:
 *
 *   - Vercel's lambdas run in UTC. A viewer does not.
 *     `new Date(t).toLocaleDateString()` for 2024-11-13T23:30Z is "Nov 13" on
 *     the server and "Nov 14" in Los Angeles. React sees the server HTML and
 *     the client render disagree on a text node and throws hydration error
 *     #418 -- which discards the server HTML and re-renders the whole subtree.
 *   - Locale is the same trap one step quieter: `(1234).toLocaleString()` is
 *     "1,234" under en-US and "1.234" under de-DE.
 *
 * Neither reproduces locally, because a dev machine serves and views from one
 * timezone and one locale. It only appears once deployed, which is the worst
 * way to find a bug of this shape.
 *
 * So both are pinned, and the formatters are built once at module scope --
 * constructing an Intl formatter is expensive enough to matter across 120 rows.
 */

const NUMBER = new Intl.NumberFormat('en-US');

/* UTC, not the viewer's zone. A file's mtime is a fact about the file, and
 * showing two people different dates for the same file is worse than showing
 * both a date that is a few hours off their wall clock. */
const DATE = new Intl.DateTimeFormat('en-US', {
  year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
});

/** "1,234". Use this instead of `.toLocaleString()` anywhere it is rendered. */
export function formatNumber(n: number): string {
  return NUMBER.format(n);
}

/** "1 file" / "6,120 files" — the desktop app pluralises counts the same way. */
export function formatCount(n: number, noun: string, plural?: string): string {
  const word = n === 1 ? noun : (plural ?? `${noun}s`);
  return `${formatNumber(n)} ${word}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

export function formatDate(ms: number): string {
  return DATE.format(new Date(ms));
}
