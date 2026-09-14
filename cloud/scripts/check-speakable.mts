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

import {
  speakableBrief,
  speakableExplanation,
  speakablePlan,
  MAX_SPEECH_CHARS,
} from '../lib/speech/speakable.js';

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

/* ---------------------------------------------------------------------------
   THE AGENT'S ANSWERS.

   Same class of bug as the brief's and the same reason a test is the only way
   to see it: nothing here throws, nothing fails a type check, and the failure
   is audible rather than visible. The one that matters most is the LAST test
   in each block -- a reading that runs long must lose the evidence, never the
   caveat, because a confident description of a file nobody opened is only safe
   to hear while the part saying nobody opened it is still attached to it.
 ------------------------------------------------------------------------- */

const spokenFile = speakableExplanation(
  { name: 'Q3_Report-final_v2.pdf', ext: 'pdf' },
  {
    summary: 'Appears to be a quarterly financial statement, one of eleven in this folder.',
    reads: ['the word "Q3" in the name', 'the Finance folder', 'the label Invoice'],
    unknowns: ['the figures themselves', 'who signed it'],
    confidence: 'medium',
  },
);

// A file name is written for a filesystem. Separators are not words.
absent('no underscores survive', spokenFile.text, '_');
absent('no hyphens survive in the name', spokenFile.text, '-final');
contains('the name is spoken as words', spokenFile.text, 'Q3 Report final v2');

/* The type leads and takes "the", never "a" -- the article an extension wants
   depends on how it is pronounced (an SVG, a PDF, a MOV) and there is no rule
   here that gets all three right. */
contains('the type leads the name', spokenFile.text, 'About the PDF file Q3 Report');
absent('and never guesses an article', spokenFile.text, ', a PDF');

contains('the summary is read', spokenFile.text, 'quarterly financial statement');
contains('the evidence is a semicolon list', spokenFile.text,
  'It reads that from: the word "Q3" in the name; the Finance folder');
contains('the limits are read', spokenFile.text,
  'It cannot tell you, without opening the file itself: the figures themselves');
// A byline on screen; a sentence in the ear.
contains('confidence is spoken as a sentence', spokenFile.text, 'Confidence is medium:');

/* An empty unknowns list must still produce the caveat. explain.ts defaults it,
   but this module is the last thing between a model's omission and a listener,
   so it does not rely on that. */
const noUnknowns = speakableExplanation(
  { name: 'notes.txt', ext: 'txt' },
  { summary: 'A text file.', reads: [], unknowns: [], confidence: 'low' },
);
contains('an empty unknowns list still says the limit', noUnknowns.text,
  'It cannot tell you anything that is actually inside the file.');

// No summary is nothing to read, not a reading of the caveats alone.
const noSummary = speakableExplanation(
  { name: 'x.pdf', ext: 'pdf' },
  { summary: '   ', reads: ['a'], unknowns: ['b'], confidence: 'high' },
);
check('an explanation with no summary is empty', noSummary.text, '');

/* THE LOAD-BEARING ONE. Over the cap, the evidence goes and the caveat stays. */
const longOne = speakableExplanation(
  { name: 'big.pdf', ext: 'pdf' },
  {
    summary: `${'This is a long hedged sentence about the file. '.repeat(37)}`,
    reads: [`${'a piece of evidence '.repeat(20)}`, `${'another one '.repeat(20)}`],
    unknowns: ['what is actually inside it'],
    confidence: 'low',
  },
);
check('a long explanation stays within the cap', longOne.chars <= MAX_SPEECH_CHARS, true);
check('and says so', longOne.truncated, true);
contains('the caveat survives the cap', longOne.text, 'what is actually inside it');
contains('and so does the confidence', longOne.text, 'Confidence is low');
absent('the evidence is what was dropped', longOne.text, 'a piece of evidence');

/* An underscore is a word boundary a filesystem forced someone to spell
   differently, and it turns up INSIDE the model's own sentences -- a folder
   quoted in a summary, a file name quoted in the evidence. Read literally it
   is "art underscore assets", which is nobody's sentence. */
const pathy = speakableExplanation(
  { name: 'echowraith_palette_050.psd', ext: 'psd' },
  {
    summary: "Filed under Art_Assets/EchoWraith/Materials/.",
    reads: ["folder 'Art_Assets/EchoWraith'"],
    unknowns: ['the layer structure'],
    confidence: 'medium',
  },
);
absent('no underscore is ever spoken', pathy.text, '_');
contains('a path keeps its slashes, which do read', pathy.text, 'Art Assets/EchoWraith');

/* ---- view plans ---- */

const label = (kind: string) => ({ topic: 'Topic', date: 'Year' }[kind] ?? kind);

const spokenPlan = speakablePlan(
  {
    mode: 'tags',
    tags: { topic: ['finance', 'legal'], date: ['2024'] },
    q: 'elephant',
    title: 'Where finance and legal meet',
    why: 'A tag graph shows which labels files carry together.',
    dropped: [{ axis: 'topic', name: 'purple' }],
  },
  1234,
  label,
);

contains('the plan opens with its title', spokenPlan.text, 'Showing: Where finance and legal meet.');
/* THE COUNT IS ARITHMETIC and is spoken as a grouped number -- "one thousand
   two hundred and thirty four" is what a synthesiser makes of 1,234, and that
   is the right reading. */
contains('the count is read', spokenPlan.text, '1,234 files match.');
contains('the axes are named in words', spokenPlan.text, 'Filtered to topic finance or legal');
contains('and joined so two axes do not run together', spokenPlan.text, ', and year 2024');
contains('a name search is spoken as one', spokenPlan.text, 'names containing "elephant"');
contains('the drawing is described, not named', spokenPlan.text, 'a web of labels');
absent('the mode is not read as a bare word', spokenPlan.text, 'mode tags');
contains('the reason is read', spokenPlan.text, 'A tag graph shows which labels');
contains('and what it ignored is read', spokenPlan.text,
  'It ignored "purple": there is no such label in this library');

const onePlan = speakablePlan(
  { mode: 'files', tags: {}, title: 'Everything', why: '', dropped: [] },
  1,
  label,
);
check('one match is singular', onePlan.text.includes('One file matches.'), true);
contains('an empty filter says so', onePlan.text, 'Nothing is filtered out');

/* The same guarantee as the explanation: the model's reason is the droppable
   half, and the ignored terms are not. */
const longPlan = speakablePlan(
  {
    mode: 'pyramid',
    tags: { topic: ['finance'] },
    title: 'A plan',
    why: `${'This is the reason the model gave. '.repeat(60)}`,
    dropped: [{ axis: 'topic', name: 'purple' }],
  },
  9,
  label,
);
check('a long plan stays within the cap', longPlan.chars <= MAX_SPEECH_CHARS, true);
contains('what it ignored survives the cap', longPlan.text, 'It ignored "purple"');
absent('the reason is what was dropped', longPlan.text, 'This is the reason the model gave');

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
