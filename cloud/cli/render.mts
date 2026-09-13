/* Turning answers into something readable in a terminal.
 *
 * Two rules, both borrowed from what the web app already decided:
 *
 *   1. Never convey meaning with colour alone. A pipe strips it, NO_COLOR
 *      turns it off, and roughly one reader in twelve cannot use it anyway.
 *      Colour here only ever emphasises something the words already say.
 *   2. Say what was counted, not just the count. "387 files" on its own
 *      invites the reader to supply their own idea of which 387.
 */

const NO_COLOR = Boolean(process.env.NO_COLOR)
  || process.argv.includes('--no-color')
  || !process.stdout.isTTY;

/* Written as an explicit escape rather than a literal ESC byte: an invisible
   control character in source is unreadable in a diff and survives a
   copy-paste only by luck. */
const ESC = String.fromCharCode(27);
const code = (n: string) => (s: string) =>
  (NO_COLOR ? s : `${ESC}[${n}m${s}${ESC}[0m`);

export const bold = code('1');
export const dim = code('2');
export const red = code('31');
export const green = code('32');
export const yellow = code('33');
export const blue = code('36');

/** Display width, counting an emoji or CJK glyph as two columns so a table
 *  containing one does not shear. Not a full grapheme segmenter -- it handles
 *  the ranges that actually turn up in file names. */
function width(text: string): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x1100 && (
      cp <= 0x115f
      || (cp >= 0x2e80 && cp <= 0xa4cf)
      || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0xfe30 && cp <= 0xfe6f)
      || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0x1f300 && cp <= 0x1f9ff)
    )) n += 2;
    else n += 1;
  }
  return n;
}

function pad(text: string, to: number): string {
  const gap = to - width(text);
  return gap > 0 ? text + ' '.repeat(gap) : text;
}

export function truncate(text: string, max: number): string {
  if (width(text) <= max) return text;
  let out = '';
  for (const ch of text) {
    if (width(out) + 1 >= max) break;
    out += ch;
  }
  return `${out}…`;
}

export interface Column {
  header: string;
  /** Right-aligned, for numbers. Everything else reads better left. */
  right?: boolean;
  /** Hard cap; the column shrinks to fit its content when it can. */
  max?: number;
}

export function table(columns: Column[], rows: string[][]): string {
  const widths = columns.map((c, i) => {
    const longest = Math.max(width(c.header), ...rows.map((r) => width(r[i] ?? '')));
    return c.max ? Math.min(longest, c.max) : longest;
  });

  const line = (cells: string[], style: (s: string) => string = (s) => s) =>
    style(
      cells
        .map((cell, i) => {
          const text = truncate(cell ?? '', widths[i]);
          return columns[i].right
            ? ' '.repeat(Math.max(0, widths[i] - width(text))) + text
            : pad(text, widths[i]);
        })
        .join('  ')
        .trimEnd(),
    );

  return [
    line(columns.map((c) => c.header), (s) => bold(s)),
    ...rows.map((r) => line(r)),
  ].join('\n');
}

export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)}${units[unit]}`;
}

export function count(n: number): string {
  return n.toLocaleString('en-US');
}

export function date(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toISOString().slice(0, 10);
}

/** Wraps prose to the terminal width, so a paragraph from the model does not
 *  arrive as one 900-character line. */
export function wrap(text: string, indent = ''): string {
  const limit = Math.min((process.stdout.columns || 80) - indent.length, 88);
  const out: string[] = [];
  let line = '';

  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && width(line) + 1 + width(word) > limit) {
      out.push(indent + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(indent + line);
  return out.join('\n');
}

/** The brief's markdown, rendered for a terminal. Same closed grammar
 *  lib/brief/compile.ts emits and lib/speech/speakable.ts translates -- three
 *  renderers, one grammar, and none of them a markdown library. */
export function markdown(text: string): string {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (!t) {
      out.push('');
    } else if (t.startsWith('### ')) {
      out.push(bold(t.slice(4).toUpperCase()));
    } else if (t.startsWith('- ')) {
      const item = t.slice(2);
      const cut = item.lastIndexOf(' — ');
      out.push(cut === -1
        ? `  ${inline(item)}`
        : `  ${pad(inline(item.slice(0, cut)), 34)} ${dim(item.slice(cut + 3))}`);
    } else {
      out.push(wrap(inline(t)));
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function inline(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, (_, inner: string) => bold(inner));
}
