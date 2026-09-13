/* Asserts the brief-to-speech translation, without a key or a network.
 *
 * The awkward cases are all in the markdown grammar compileBrief emits, and
 * every one of them is silent when it goes wrong: a heading read as "hash hash
 * hash", an em dash read as nothing, a cap that ends the audio mid-word. None
 * of those throw, none fail a type check, and none are visible without
 * listening -- which is exactly the shape of bug a test is for.
 *
 * Run with `npm run check:speech`.
 */

import { speakableBrief, MAX_SPEECH_CHARS } from '../lib/speech/speakable.js';

let failed = 0;
let passed = 0;

function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${name}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
  }
}

function contains(name: string, haystack: string, needle: string) {
  check(name, haystack.includes(needle), true);
}

function absent(name: string, haystack: string, needle: string) {
  check(`${name} (absent)`, haystack.includes(needle), false);
}

/* The real grammar, copied from lib/brief/compile.ts rather than paraphrased:
   a bold-leading summary line, a flag list, count rows joined by an em dash,
   and the "When" paragraph. */
const BODY = [
  '**42 files**, 1.2 GB, modified 2023–2025, matching "finance".',
  '',
  '### Worth a look',
  '- 3 files carry no date',
  '',
  '### What these are',
  '- invoice — 28',
  '- report — 14',
  '',
  '### When',
  '2024 (30), 2023 (12).',
  '',
].join('\n');

const spoken = speakableBrief({
  title: '42 invoice files, mostly finance',
  intro: 'These are supplier invoices from two vendors.',
  body: BODY,
});

// Nothing that only means something on a screen survives.
absent('no heading marks', spoken.text, '###');
absent('no bold marks', spoken.text, '**');
absent('no list dashes', spoken.text, '- ');
absent('no em dash', spoken.text, '—');

// The title opens the reading, the model's paragraph follows it, and the
// counts come last -- a listener needs to know what the set is before hearing
// numbers about it.
check(
  'opens with the title',
  spoken.text.startsWith('42 invoice files, mostly finance.'),
  true,
);
contains('keeps the intro', spoken.text, 'These are supplier invoices from two vendors.');

// A heading becomes the label of the list it introduces, and the em dash that
// was doing a table column becomes the pause a listener can hear.
contains('heading labels its list', spoken.text, 'What these are: invoice, 28; report, 14.');
// A heading followed by a paragraph attaches to the paragraph instead.
contains('heading labels a paragraph', spoken.text, 'When: 2024 (30), 2023 (12).');
// A flag list has no counts in it, so rows pass through whole.
contains('flags survive', spoken.text, 'Worth a look: 3 files carry no date.');

check('not truncated', spoken.truncated, false);
check('chars match text', spoken.chars, spoken.text.length);

/* Truncation. Sentences of a known length, enough of them to pass the cap. */
const long = Array.from({ length: 400 }, (_, i) => `- item ${i} — ${i}`).join('\n');
const cut = speakableBrief({ title: 'Long', body: `### Rows\n${long}\n` });
check('truncates', cut.truncated, true);
check('within the cap', cut.chars <= MAX_SPEECH_CHARS, true);
check('does not end mid-word', /[.!?]$/.test(cut.text), true);

/* One sentence longer than the whole cap: there is no sentence boundary to
   fall back to, so it must cut on a word and still terminate. */
const runOn = speakableBrief({
  title: '',
  body: Array.from({ length: 600 }, () => 'word').join(' '),
});
check('run-on stays within the cap', runOn.chars <= MAX_SPEECH_CHARS, true);
check('run-on still terminates', /[.!?]$/.test(runOn.text), true);
absent('run-on does not split a word', runOn.text, 'wor.');

/* The empty selection. compileBrief answers "No files match this filter." and
   speaking that is correct -- but a brief with nothing in it at all must not
   produce a call, so the route checks `files === 0` before ever getting here.
   This asserts the degenerate input is at least harmless. */
const empty = speakableBrief({ title: '', body: '' });
check('empty is empty', empty.text, '');
check('empty counts zero', empty.chars, 0);

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
