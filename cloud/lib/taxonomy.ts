/* The vocabulary, ported from the Python engine.
 *
 * Sources of truth, in order:
 *   DOCTYPES / TOPICS  -> athena/agent/taxonomy.py:83-389
 *   PATTERNS           -> athena/agent/patterns.py
 *   GAMES / TEAM       -> make_mock_library.py:327-340
 *
 * These are duplicated rather than shared because the Vercel build cannot see
 * outside its Root Directory (`cloud/`). Duplication that cannot be prevented
 * should at least be checked, so `npm run check:taxonomy` re-extracts the names
 * from the Python files and fails if these lists have drifted. That check runs
 * locally and in CI -- never in the Vercel build, which has no athena/ to read.
 */

export interface Category {
  name: string;
  display: string;
}

/** athena/agent/taxonomy.py DOCTYPES. `photo` and `recording` are included:
 *  they are real doctypes there, covering media that has no document body. */
export const DOCTYPES: Category[] = [
  { name: 'invoice', display: 'Invoice' },
  { name: 'receipt', display: 'Receipt' },
  { name: 'statement', display: 'Statement' },
  { name: 'contract', display: 'Contract' },
  { name: 'report', display: 'Report' },
  { name: 'presentation', display: 'Presentation' },
  { name: 'spreadsheet', display: 'Spreadsheet' },
  { name: 'log', display: 'Log' },
  { name: 'source-code', display: 'Source code' },
  { name: 'resume', display: 'CV / Resume' },
  { name: 'letter', display: 'Letter' },
  { name: 'meeting-notes', display: 'Meeting notes' },
  { name: 'form', display: 'Form' },
  { name: 'paper', display: 'Paper' },
  { name: 'manual', display: 'Manual' },
  { name: 'policy', display: 'Policy' },
  { name: 'proposal', display: 'Proposal' },
  { name: 'transcript', display: 'Transcript' },
  { name: 'screenshot', display: 'Screenshot' },
  { name: 'certificate', display: 'Certificate' },
  { name: 'photo', display: 'Photo' },
  { name: 'recording', display: 'Recording' },
];

/** athena/agent/taxonomy.py TOPICS. */
export const TOPICS: Category[] = [
  { name: 'finance', display: 'Finance' },
  { name: 'legal', display: 'Legal' },
  { name: 'hr', display: 'People & HR' },
  { name: 'engineering', display: 'Engineering' },
  { name: 'marketing', display: 'Marketing' },
  { name: 'sales', display: 'Sales' },
  { name: 'research', display: 'Research' },
  { name: 'medical', display: 'Medical' },
  { name: 'education', display: 'Education' },
  { name: 'operations', display: 'Operations' },
  { name: 'security', display: 'Security' },
  { name: 'personal', display: 'Personal' },
  { name: 'travel', display: 'Travel' },
  { name: 'design', display: 'Design' },
];

/** athena/agent/patterns.py. The structural findings -- these are the tags that
 *  make the tag graph *explain* rather than restate. */
export const PATTERNS: Category[] = [
  { name: 'money', display: 'Monetary amounts' },
  { name: 'invoice-number', display: 'Invoice reference' },
  { name: 'amount-due', display: 'Amount due' },
  { name: 'tax-id', display: 'Tax registration' },
  { name: 'iban', display: 'Bank details' },
  { name: 'accounting-period', display: 'Accounting period' },
  { name: 'log-line', display: 'Timestamped log lines' },
  { name: 'severity-level', display: 'Severity levels' },
  { name: 'stack-trace', display: 'Stack trace' },
  { name: 'source-code', display: 'Code' },
  { name: 'sql', display: 'SQL' },
  { name: 'url', display: 'Links' },
  { name: 'email-address', display: 'Email addresses' },
  { name: 'phone-number', display: 'Phone numbers' },
  { name: 'ip-address', display: 'IP addresses' },
  { name: 'signature-block', display: 'Signature' },
  { name: 'salutation', display: 'Salutation' },
  { name: 'action-items', display: 'Action items' },
  { name: 'attendees', display: 'Attendees' },
  { name: 'legalese', display: 'Legal boilerplate' },
  { name: 'clause-numbering', display: 'Numbered clauses' },
  { name: 'citation', display: 'Citations' },
  { name: 'table-row', display: 'Tabular data' },
  { name: 'blank-field', display: 'Fillable fields' },
  { name: 'percentage', display: 'Percentages' },
  { name: 'credentials', display: 'Possible secrets' },
  { name: 'national-id', display: 'Possible national ID' },
  { name: 'date-of-birth', display: 'Date of birth' },
  { name: 'medical-terms', display: 'Clinical language' },
  { name: 'screenshot-name', display: 'Named as a screenshot' },
  { name: 'sequence-name', display: 'Camera sequence name' },
  { name: 'version-name', display: 'Versioned filename' },
];

/** make_mock_library.py GAMES. Used as `entity` tags -- they produce seven
 *  tight project clusters, which is most of the visible structure in the
 *  file graph. */
export const GAMES = [
  'Vortex_Rising',
  'NeonCitadel',
  'EchoWraith',
  'SolarVanguard',
  'CrimsonSerpent',
  'Project_Orakel',
  'Spectral_Drift',
];

/** make_mock_library.py TEAM_MEMBERS. Used as `author` tags. */
export const TEAM_MEMBERS = [
  'aria.chen', 'dex.morgan', 'lena.vasquez', 'kurt.paige',
  'soo.jin.park', 'omar.rashid', 'fiona.bell', 'marcus.thorn',
];

/** The filter axes and their order, from TAG_AXES in athena/web/queries.py.
 *  Order is deliberate: it is the order the facet rail renders in. */
export const TAG_AXES: { kind: string; label: string }[] = [
  { kind: 'doctype', label: 'Kind' },
  { kind: 'topic', label: 'Topic' },
  { kind: 'author', label: 'Author' },
  { kind: 'date', label: 'Year' },
  { kind: 'pattern', label: 'Contains' },
  { kind: 'entity', label: 'Named' },
  { kind: 'custom', label: 'My tags' },
  { kind: 'keyword', label: 'Keywords' },
];

export function displayFor(list: Category[], name: string): string {
  return list.find((c) => c.name === name)?.display ?? name;
}

/** Turn "aria.chen" into "Aria Chen"; leave anything else alone. */
export function humanName(handle: string): string {
  return handle
    .split('.')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}
