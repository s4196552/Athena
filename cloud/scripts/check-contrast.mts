import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* Contrast as a gate rather than a review note.
 *
 * The palette this replaced failed in ways nobody could see by looking, because
 * the failures were on the SMALLEST text: --faint was used 59 times -- more
 * often than the primary text colour -- almost entirely on 10-12px metadata,
 * where it measured 3.33:1 on the page background and 2.02:1 on a selected
 * row. Both are comfortably under the 4.5:1 the HIG states for text up to 17pt.
 *
 * So the numbers are computed from the stylesheet itself. If someone nudges a
 * hex value, this fails before it ships rather than being noticed by the one
 * person who cannot read it.
 *
 *   npm run check:contrast
 */

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'app', 'globals.css'), 'utf8');

/** The HIG's stated minimums: 4.5:1 up to 17pt, 3:1 at 18pt or bold. */
const TEXT = 4.5;
/** Dark Mode asks for more of small text: "strive for 7:1, especially in small
 *  text". Applied to anything the type scale puts at 12px or below. */
const SMALL = 7;
/** "Meaningful graphical objects" -- icons, rules, focus rings, the brand
 *  mark. The HIG's floor for something that carries meaning without carrying
 *  words. */
const GRAPHIC = 3;

function tokens(): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, name, value] of css.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    found.set(name, value);
  }
  return found;
}

function luminance(hex: string): number {
  const h = hex.length === 4
    ? '#' + [...hex.slice(1)].map((c) => c + c).join('')
    : hex;
  const channel = (i: number) => {
    const v = parseInt(h.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function ratio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const T = tokens();
function hex(name: string): string {
  const value = T.get(name);
  if (!value) throw new Error(`globals.css has no --${name}`);
  return value;
}

let failures = 0;
let checks = 0;

function check(fg: string, bg: string, floor: number, note: string) {
  checks++;
  const r = ratio(hex(fg), hex(bg));
  const ok = r >= floor;
  if (!ok) failures++;
  const line = `  ${ok ? 'PASS' : 'FAIL'}  ${fg} on ${bg}`.padEnd(46);
  console.log(`${line} ${r.toFixed(2).padStart(6)}  (needs ${floor})  ${note}`);
}

for (const mode of ['dark', 'light'] as const) {
  console.log(`\n--- ${mode} ---`);
  const surfaces = mode === 'dark'
    ? ['bg-base', 'bg-raised', 'bg-elevated', 'bg-sunk', 'fill', 'fill-2', 'fill-selected']
    : ['bg-base', 'bg-raised', 'bg-elevated', 'bg-sunk', 'fill', 'fill-2', 'fill-selected'];

  for (const surface of surfaces) {
    // label and label-2 carry text at every size, including the 11-12px
    // captions, so they answer to the stricter floor.
    check(`${mode}-label`, `${mode}-${surface}`, SMALL, 'body and small text');
    check(`${mode}-label-2`, `${mode}-${surface}`, SMALL, 'small text: counts, metadata');
    // label-3 is banned below 13px by the token comments, so 4.5 is its bar.
    check(`${mode}-label-3`, `${mode}-${surface}`, TEXT, 'secondary text, 13px and up');
    /* The BRAND red is checked at the 3:1 floor the HIG gives a meaningful
       graphical object, because that is the only job it has: a logo mark, a
       rule, a focus ring, the active edge of a control. It measures 4.35 on
       dark and 3.63 on light, so it would fail as text -- which is why the
       two roles below exist and why nothing in the app sets `color: var(--accent)`. */
    check(`${mode}-accent`, `${mode}-${surface}`, GRAPHIC, 'the brand mark, never text');
    check(`${mode}-accent-text`, `${mode}-${surface}`, TEXT, 'links and accent ink');
  }

  // The text drawn ON a filled control: selected chips, primary buttons, and
  // the destructive confirmation. Both flip with the appearance -- near-black
  // reads on the dark pink and white on the light one, and neither works for
  // both, which is why --on-danger exists at all.
  /* Against --accent-FILL, not --accent. A label sitting on the brand red
     clears only 4.35 at best in either appearance, so the filled controls use
     a slightly deeper red that takes a foreground at 4.5. The brand colour is
     unchanged; what changed is that it stopped being asked to do a job it
     cannot do. */
  check(`${mode}-on-accent`, `${mode}-accent-fill`, TEXT, 'text on an accent fill');
  check(`${mode}-on-danger`, `${mode}-danger`, TEXT, 'text on a danger fill');

  /* --label-4 is deliberately NOT checked as text. It is for disabled glyphs
     and decorative rules, and the token comment says so; the old palette's
     mistake was using a colour of exactly this weight for real content. */
}

console.log(
  `\n${failures ? `${failures} of ${checks} pairs FAILED` : `all ${checks} pairs pass`}`,
);
process.exit(failures ? 1 : 0);
