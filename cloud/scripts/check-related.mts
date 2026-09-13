/* Asserts the two arithmetic agent features against the real seed.
 *
 * Both of these are rankings, and a ranking is the kind of thing that fails
 * SILENTLY: it returns a list either way, in a plausible order, and nothing
 * about a wrong one looks wrong. This session has already shipped one ranking
 * whose signal did not vary across the catalogue, so the checks below are
 * about the DATA as much as the code -- that rare tags actually outrank common
 * ones here, and that the repeat groups are not empty.
 *
 * Run with `npm run check:related`.
 */

import { readFileSync } from 'node:fs';
import { findRelated, findRepeats, stemOf } from '../lib/agent/related.js';
import type { FileRecord, TagRecord } from '../lib/data/types.js';

let failed = 0;
let passed = 0;

function check(name: string, pass: boolean, detail = '') {
  if (pass) passed++;
  else failed++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const LIB = 'data/seed/libraries/hadesmedia-main';
const files = JSON.parse(readFileSync(`${LIB}/files.json`, 'utf8')) as FileRecord[];
const tags = JSON.parse(readFileSync(`${LIB}/tags.json`, 'utf8')) as TagRecord[];
const tagById = new Map(tags.map((t) => [t.id as number, t]));
const lens = (f: FileRecord) => f.tags as unknown as number[];

console.log(`\n--- related (${files.length} files, ${tags.length} tags) ---`);

/* The measure is only worth anything if idf actually varies here. If every tag
   were equally rare the cosine would collapse to plain overlap count, which is
   the degenerate case this asserts is not happening. */
const idfs = tags.map((t) => t.idf).filter((n) => Number.isFinite(n));
const spread = Math.max(...idfs) - Math.min(...idfs);
check('idf varies across the catalogue', spread > 2,
  `min ${Math.min(...idfs).toFixed(2)}, max ${Math.max(...idfs).toFixed(2)}`);

const target = files.find((f) => f.tags.length >= 6)!;
const related = findRelated(target, files, lens, tagById, 8);

check('finds neighbours for a well-tagged file', related.length > 0,
  `${related.length} for ${target.name}`);
check('never returns the file itself', !related.some((r) => r.fileId === target.id));
check('scores are ordered', related.every((r, i) => i === 0 || related[i - 1].score >= r.score));
check('scores are bounded to 0..1', related.every((r) => r.score > 0 && r.score <= 1.0001),
  `top ${related[0]?.score.toFixed(3)}`);
check('every neighbour names what it shares', related.every((r) => r.shared.length > 0));

/* THE ONE THAT MATTERS. A file sharing one rare tag must be able to outrank a
   file sharing several common ones -- that is the entire reason for weighting
   by idf rather than counting overlap. Asserted by construction rather than by
   hoping the seed contains an example. */
{
  const rare = tags.filter((t) => t.idf > 5).slice(0, 1);
  const common = tags.filter((t) => t.idf < 1.5).slice(0, 3);
  check('the seed has both rare and common tags to build the case',
    rare.length === 1 && common.length === 3);

  // FileId is a branded string, so a literal needs the cast. Everything else
  // is copied from a real record, which is the point: these are real files
  // with their tag lists swapped, not a hand-built shape that might not match.
  const mk = (id: string, ids: number[]): FileRecord => ({
    ...files[0], id: id as unknown as FileRecord['id'], relPath: id, name: id,
    tags: ids as unknown as FileRecord['tags'],
  });
  const subject = mk('subject', [rare[0].id as number, ...common.map((t) => t.id as number)]);
  const sharesRare = mk('shares-rare', [rare[0].id as number]);
  const sharesCommon = mk('shares-common', common.map((t) => t.id as number));

  const ranked = findRelated(subject, [sharesRare, sharesCommon], lens, tagById, 5);
  check('one rare tag outranks three common ones',
    ranked[0]?.fileId === 'shares-rare',
    ranked.map((r) => `${r.fileId} ${r.score.toFixed(3)}`).join(' > '));
}

console.log('\n--- the same name in several places ---');

check('stems drop version markers', stemOf('report_v2.pdf') === 'report',
  stemOf('report_v2.pdf'));
check('stems drop a copy index', stemOf('report (1).pdf') === 'report', stemOf('report (1).pdf'));
check('stems drop stacked markers', stemOf('report_final_v2.docx') === 'report',
  stemOf('report_final_v2.docx'));
check('a stem is never empty', stemOf('v2.pdf').length > 0, stemOf('v2.pdf'));

const repeats = findRepeats(files, 20);
check('the seed actually has repeats to show', repeats.length > 0, `${repeats.length} groups`);
check('every group spans more than one folder', repeats.every((r) => r.folders >= 2));
check('every group has more than one file', repeats.every((r) => r.files.length >= 2));
check('groups are ordered by spread',
  repeats.every((r, i) => i === 0 || repeats[i - 1].folders >= r.folders));

/* The claim printed on the page is that these are NOT duplicates. If the seed
   ever gained two files with the same content hash, that sentence would become
   a lie, and this is what would catch it. */
check('no group is byte-identical, so "not duplicates" stays true',
  repeats.every((r) => r.distinctContent === r.files.length),
  repeats.map((r) => `${r.stem}:${r.distinctContent}/${r.files.length}`).slice(0, 3).join(' '));

if (repeats[0]) {
  console.log(`  (worst: ${repeats[0].stem}.${repeats[0].ext} — `
    + `${repeats[0].files.length} files in ${repeats[0].folders} folders)`);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
