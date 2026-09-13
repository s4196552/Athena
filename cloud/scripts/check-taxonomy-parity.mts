/* Fails if lib/taxonomy.ts has drifted from the Python engine.
 *
 * The TS copy exists because the Vercel build cannot read outside `cloud/`.
 * That makes drift possible but not acceptable: a doctype renamed in Python
 * would silently keep its old display string in the web app, and nobody would
 * notice until a screenshot looked wrong.
 *
 * Run locally and in CI (`npm run check:taxonomy`), never in the Vercel build,
 * which has no athena/ to read.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCTYPES, TOPICS, PATTERNS, GAMES, TEAM_MEMBERS } from '../lib/taxonomy.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

/** Both files declare entries as `Category(\n "name", "Display", ...)` or
 *  `Pattern("name", "Display", ...)`, so one regex covers both layouts. */
function extract(file: string, ctor: 'Category' | 'Pattern'): Map<string, string> {
  const src = readFileSync(file, 'utf8');
  const re = new RegExp(`${ctor}\\(\\s*"([a-z0-9-]+)",\\s*"([^"]+)"`, 'g');
  const out = new Map<string, string>();
  for (const m of src.matchAll(re)) out.set(m[1], m[2]);
  return out;
}

function extractList(file: string, varName: string): string[] {
  const src = readFileSync(file, 'utf8');
  const m = new RegExp(`^${varName}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm').exec(src);
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

const problems: string[] = [];

function compare(label: string, py: Map<string, string>, ts: { name: string; display: string }[]) {
  if (py.size === 0) {
    problems.push(`${label}: extracted nothing from Python — the regex or the file layout changed.`);
    return;
  }
  const tsMap = new Map(ts.map((c) => [c.name, c.display]));
  for (const [name, display] of py) {
    if (!tsMap.has(name)) problems.push(`${label}: "${name}" exists in Python but not in lib/taxonomy.ts`);
    else if (tsMap.get(name) !== display)
      problems.push(`${label}: "${name}" display differs — Python "${display}" vs TS "${tsMap.get(name)}"`);
  }
  for (const name of tsMap.keys()) {
    if (!py.has(name)) problems.push(`${label}: "${name}" exists in lib/taxonomy.ts but not in Python`);
  }
}

function compareList(label: string, py: string[], ts: string[]) {
  if (py.length === 0) {
    problems.push(`${label}: extracted nothing from Python.`);
    return;
  }
  if (py.join('|') !== ts.join('|')) {
    problems.push(`${label}: differs —\n    Python: ${py.join(', ')}\n    TS:     ${ts.join(', ')}`);
  }
}

const taxonomyPy = join(repo, 'athena', 'agent', 'taxonomy.py');
const patternsPy = join(repo, 'athena', 'agent', 'patterns.py');
const mockPy = join(repo, 'make_mock_library.py');

if (!existsSync(taxonomyPy)) {
  console.log('check:taxonomy — athena/ not reachable from here, skipping.');
  console.log('  (expected inside the Vercel build; a problem anywhere else)');
  process.exit(0);
}

// taxonomy.py holds DOCTYPES then TOPICS in one file, so split on the section
// header the file itself uses rather than trying to scope the regex.
const taxSrc = readFileSync(taxonomyPy, 'utf8');
const splitAt = taxSrc.indexOf('TOPICS: tuple[Category, ...]');
const doctypeSrc = taxSrc.slice(0, splitAt);
const topicSrc = taxSrc.slice(splitAt);

const reCat = /Category\(\s*"([a-z0-9-]+)",\s*"([^"]+)"/g;
const mapOf = (s: string) => new Map([...s.matchAll(reCat)].map((m) => [m[1], m[2]]));

compare('DOCTYPES', mapOf(doctypeSrc), DOCTYPES);
compare('TOPICS', mapOf(topicSrc), TOPICS);
compare('PATTERNS', extract(patternsPy, 'Pattern'), PATTERNS);
compareList('GAMES', extractList(mockPy, 'GAMES'), GAMES);
compareList('TEAM_MEMBERS', extractList(mockPy, 'TEAM_MEMBERS'), TEAM_MEMBERS);

if (problems.length) {
  console.error('check:taxonomy FAILED — lib/taxonomy.ts has drifted from the Python engine:\n');
  for (const p of problems) console.error('  • ' + p);
  console.error('\nUpdate cloud/lib/taxonomy.ts to match, then re-run.');
  process.exit(1);
}

console.log(
  `check:taxonomy OK — ${DOCTYPES.length} doctypes, ${TOPICS.length} topics, ` +
  `${PATTERNS.length} patterns, ${GAMES.length} games, ${TEAM_MEMBERS.length} team members.`
);
