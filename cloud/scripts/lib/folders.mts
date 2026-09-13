/* The shape of the HadesMedia library.
 *
 * Transplanted from the tree make_mock_library.py builds under
 * mock_library/HermesMedia -- same twelve top-level folders, same
 * sub-structure, same seven game code-names -- so the cloud demo and the
 * desktop demo look like the same company's data.
 *
 * The weights are the important part. Uniform random tagging produces a
 * uniform grey blob; structure in the graph comes from *correlation*, so every
 * topic draw is conditioned on the folder it happens in. Marketing_Assets is
 * overwhelmingly marketing, Documents/Finance is overwhelmingly finance, and
 * the ~15% crossover is what creates the bridges between clusters rather than
 * leaving them as disconnected islands.
 */

export interface FolderSpec {
  /** Path prefix, ending in '/'. */
  path: string;
  /** Relative share of the library's files. */
  share: number;
  /** topic name -> weight. */
  topics: Record<string, number>;
  /** extension -> weight. */
  exts: Record<string, number>;
  /** Authors who dominate this folder. Authorship correlated with folder is
   *  what makes author nodes sit *inside* clusters instead of bridging
   *  everything, which is what happens if you assign them uniformly. */
  authors?: Record<string, number>;
  /** Expand into one sub-folder per game, and tag with that game as `entity`. */
  perGame?: boolean;
  /** Fixed sub-folders to spread files across. */
  subs?: string[];
}

export const FOLDERS: FolderSpec[] = [
  {
    path: 'Art_Assets/',
    share: 0.16,
    subs: ['Concept_Art', 'Textures', 'Models', 'Sprites', 'Materials'],
    topics: { design: 0.70, marketing: 0.15, engineering: 0.15 },
    exts: { psd: 0.28, png: 0.30, fbx: 0.14, jpg: 0.18, tga: 0.10 },
    authors: { 'aria.chen': 0.70, 'lena.vasquez': 0.18, 'kurt.paige': 0.12 },
    perGame: true,
  },
  {
    path: 'Audio/',
    share: 0.09,
    subs: ['SFX', 'Music', 'Voice', 'Ambience'],
    topics: { design: 0.50, engineering: 0.30, marketing: 0.20 },
    exts: { wav: 0.55, mp3: 0.25, flac: 0.12, ogg: 0.08 },
    authors: { 'soo.jin.park': 0.65, 'dex.morgan': 0.20, 'fiona.bell': 0.15 },
  },
  {
    path: 'Brand_Identity/',
    share: 0.05,
    subs: ['Logos', 'Guidelines', 'Typography', 'Palettes'],
    topics: { marketing: 0.58, design: 0.42 },
    exts: { svg: 0.30, png: 0.28, pdf: 0.24, ai: 0.18 },
    authors: { 'fiona.bell': 0.62, 'aria.chen': 0.22, 'lena.vasquez': 0.16 },
  },

  // --- Documents: the half Finance can see. Split finely, because these
  //     sub-folders are what make the two workspaces' scopes genuinely differ.
  {
    path: 'Documents/Finance/',
    share: 0.055,
    subs: ['Invoices', 'Statements', 'Budgets', 'Payroll'],
    topics: { finance: 0.85, legal: 0.15 },
    exts: { xlsx: 0.42, pdf: 0.40, csv: 0.18 },
    authors: { 'omar.rashid': 0.72, 'kurt.paige': 0.28 },
  },
  {
    path: 'Documents/Legal/',
    share: 0.035,
    subs: ['Contracts', 'Licences', 'Policies', 'NDAs'],
    topics: { legal: 0.80, finance: 0.20 },
    exts: { pdf: 0.62, docx: 0.38 },
    authors: { 'kurt.paige': 0.68, 'omar.rashid': 0.32 },
  },
  {
    path: 'Documents/HR/',
    share: 0.03,
    subs: ['Onboarding', 'Reviews', 'Recruitment'],
    topics: { hr: 0.85, operations: 0.15 },
    exts: { pdf: 0.50, docx: 0.40, xlsx: 0.10 },
    authors: { 'fiona.bell': 0.70, 'lena.vasquez': 0.30 },
  },
  {
    path: 'Documents/Project_Management/',
    share: 0.05,
    subs: ['Schedules', 'Budgets', 'Retrospectives', 'Status_Reports'],
    topics: { operations: 0.45, finance: 0.35, hr: 0.20 },
    exts: { xlsx: 0.38, pdf: 0.30, docx: 0.22, pptx: 0.10 },
    authors: { 'lena.vasquez': 0.55, 'omar.rashid': 0.25, 'dex.morgan': 0.20 },
  },
  {
    path: 'Documents/Game_Design_Documents/',
    share: 0.045,
    topics: { design: 0.50, engineering: 0.30, research: 0.20 },
    exts: { pdf: 0.45, docx: 0.35, md: 0.20 },
    authors: { 'dex.morgan': 0.55, 'aria.chen': 0.25, 'marcus.thorn': 0.20 },
    perGame: true,
  },
  {
    path: 'Documents/QA/',
    share: 0.04,
    topics: { engineering: 0.60, operations: 0.40 },
    exts: { xlsx: 0.40, csv: 0.30, pdf: 0.18, md: 0.12 },
    authors: { 'marcus.thorn': 0.50, 'soo.jin.park': 0.28, 'dex.morgan': 0.22 },
    perGame: true,
  },

  {
    path: 'Engineering/',
    share: 0.13,
    subs: ['Source', 'Builds', 'Logs', 'Shaders', 'Tests'],
    topics: { engineering: 0.85, security: 0.15 },
    exts: { py: 0.20, cpp: 0.18, log: 0.24, json: 0.16, h: 0.12, hlsl: 0.10 },
    authors: { 'marcus.thorn': 0.65, 'dex.morgan': 0.20, 'soo.jin.park': 0.15 },
  },
  {
    path: 'Localisation/',
    share: 0.04,
    subs: ['Strings', 'VO_Scripts', 'Glossaries'],
    topics: { operations: 0.50, marketing: 0.30, design: 0.20 },
    exts: { xlsx: 0.42, csv: 0.28, json: 0.20, docx: 0.10 },
    authors: { 'soo.jin.park': 0.55, 'fiona.bell': 0.25, 'lena.vasquez': 0.20 },
  },
  {
    path: 'Marketing_Assets/',
    share: 0.115,
    subs: ['Campaigns', 'Social', 'Press', 'Store_Pages', 'Key_Art'],
    topics: { marketing: 0.68, design: 0.22, sales: 0.10 },
    exts: { png: 0.28, psd: 0.22, jpg: 0.20, pdf: 0.16, pptx: 0.14 },
    authors: { 'fiona.bell': 0.58, 'aria.chen': 0.24, 'lena.vasquez': 0.18 },
    perGame: true,
  },
  {
    path: 'Photography_and_Reference/',
    share: 0.09,
    subs: ['Location_Scouting', 'Studio', 'Texture_Reference', 'Motion_Capture'],
    topics: { design: 0.55, research: 0.28, marketing: 0.17 },
    exts: { jpg: 0.48, png: 0.22, raw: 0.18, tif: 0.12 },
    authors: { 'aria.chen': 0.45, 'kurt.paige': 0.30, 'lena.vasquez': 0.25 },
  },
  {
    path: 'Pipeline_and_Tools/',
    share: 0.05,
    subs: ['Exporters', 'Build_Scripts', 'Validators'],
    topics: { engineering: 0.70, operations: 0.30 },
    exts: { py: 0.44, sh: 0.20, json: 0.22, md: 0.14 },
    authors: { 'marcus.thorn': 0.58, 'soo.jin.park': 0.24, 'dex.morgan': 0.18 },
  },
  {
    path: 'Video/',
    share: 0.055,
    subs: ['Trailers', 'Captures', 'Cutscenes', 'Devlogs'],
    topics: { marketing: 0.50, design: 0.30, operations: 0.20 },
    exts: { mp4: 0.52, mov: 0.30, webm: 0.18 },
    authors: { 'fiona.bell': 0.45, 'dex.morgan': 0.30, 'aria.chen': 0.25 },
    perGame: true,
  },
  {
    path: '_Archive/',
    share: 0.05,
    subs: ['2022', '2023', 'Deprecated', 'Old_Builds'],
    topics: {
      operations: 0.22, finance: 0.18, marketing: 0.16, engineering: 0.16,
      design: 0.14, legal: 0.14,
    },
    exts: { pdf: 0.24, zip: 0.18, png: 0.18, xlsx: 0.16, log: 0.14, docx: 0.10 },
  },
  {
    path: '_Shared/',
    share: 0.025,
    subs: ['Handoffs', 'External_Review', 'Templates'],
    topics: {
      operations: 0.25, marketing: 0.20, design: 0.18,
      finance: 0.15, legal: 0.12, hr: 0.10,
    },
    exts: { pdf: 0.30, docx: 0.22, xlsx: 0.20, pptx: 0.16, png: 0.12 },
  },
];

/** ext -> media_type, matching the CHECK constraint on asset.media_type. */
export const MEDIA_BY_EXT: Record<string, string> = {
  png: 'image', jpg: 'image', jpeg: 'image', psd: 'image', tga: 'image',
  tif: 'image', raw: 'image', svg: 'image', ai: 'image',
  mp4: 'video', mov: 'video', webm: 'video',
  wav: 'audio', mp3: 'audio', flac: 'audio', ogg: 'audio',
  pdf: 'document', docx: 'document', pptx: 'document', xlsx: 'document',
  csv: 'document', md: 'document',
  py: 'other', cpp: 'other', h: 'other', hlsl: 'other', sh: 'other',
  json: 'other', log: 'other', fbx: 'other', zip: 'other',
};

/** Typical byte size per extension, as [min, max]. Only needs to be plausible
 *  -- it drives the size facet and the "library size" figure, nothing else. */
export const BYTES_BY_EXT: Record<string, [number, number]> = {
  png: [180_000, 9_000_000], jpg: [220_000, 7_000_000], psd: [8_000_000, 180_000_000],
  tga: [1_000_000, 24_000_000], tif: [4_000_000, 60_000_000], raw: [18_000_000, 45_000_000],
  svg: [3_000, 90_000], ai: [900_000, 22_000_000],
  mp4: [12_000_000, 900_000_000], mov: [30_000_000, 1_400_000_000], webm: [6_000_000, 300_000_000],
  wav: [800_000, 60_000_000], mp3: [900_000, 14_000_000], flac: [6_000_000, 70_000_000],
  ogg: [400_000, 9_000_000],
  pdf: [90_000, 14_000_000], docx: [24_000, 3_000_000], pptx: [500_000, 48_000_000],
  xlsx: [18_000, 4_000_000], csv: [900, 2_400_000], md: [700, 120_000],
  py: [900, 180_000], cpp: [1_800, 400_000], h: [500, 60_000], hlsl: [700, 40_000],
  sh: [300, 20_000], json: [400, 5_000_000], log: [4_000, 90_000_000],
  fbx: [2_000_000, 260_000_000], zip: [3_000_000, 900_000_000],
};

/** Doctype conditioned on extension AND topic. This pair is what makes the tag
 *  graph informative: `xlsx` alone says "spreadsheet", but `xlsx` under
 *  `finance` is usually a statement or a budget, and that difference is a real
 *  edge between Finance and Statement rather than a base rate. */
export function doctypeFor(ext: string, topic: string): Record<string, number> {
  const media = MEDIA_BY_EXT[ext];
  if (media === 'image') {
    return ext === 'png' || ext === 'jpg'
      ? { photo: 0.55, screenshot: 0.25, presentation: 0.20 }
      : { photo: 0.80, screenshot: 0.20 };
  }
  if (media === 'audio') return { recording: 1 };
  if (media === 'video') return { recording: 0.75, presentation: 0.25 };
  if (ext === 'log') return { log: 1 };
  if (ext === 'py' || ext === 'cpp' || ext === 'h' || ext === 'hlsl' || ext === 'sh') {
    return { 'source-code': 1 };
  }
  if (ext === 'json') return { 'source-code': 0.55, spreadsheet: 0.25, form: 0.20 };
  if (ext === 'pptx') return { presentation: 0.85, proposal: 0.15 };
  if (ext === 'csv') return { spreadsheet: 0.70, log: 0.18, report: 0.12 };

  if (ext === 'xlsx') {
    if (topic === 'finance') return { spreadsheet: 0.45, statement: 0.33, report: 0.22 };
    if (topic === 'hr') return { spreadsheet: 0.55, form: 0.25, report: 0.20 };
    return { spreadsheet: 0.72, report: 0.28 };
  }
  if (ext === 'pdf' || ext === 'docx') {
    if (topic === 'finance') {
      return { invoice: 0.34, statement: 0.24, receipt: 0.16, report: 0.16, proposal: 0.10 };
    }
    if (topic === 'legal') {
      return { contract: 0.46, policy: 0.26, certificate: 0.14, report: 0.14 };
    }
    if (topic === 'hr') {
      return { resume: 0.34, policy: 0.22, form: 0.20, letter: 0.14, certificate: 0.10 };
    }
    if (topic === 'research') return { paper: 0.52, report: 0.30, transcript: 0.18 };
    if (topic === 'engineering') return { manual: 0.40, report: 0.30, 'meeting-notes': 0.30 };
    if (topic === 'operations') {
      return { report: 0.34, 'meeting-notes': 0.30, manual: 0.20, form: 0.16 };
    }
    if (topic === 'marketing') return { proposal: 0.34, presentation: 0.30, report: 0.36 };
    return { report: 0.40, proposal: 0.24, manual: 0.20, letter: 0.16 };
  }
  if (ext === 'md') return { manual: 0.42, 'meeting-notes': 0.34, report: 0.24 };
  return { report: 1 };
}

/** Patterns conditioned strictly on doctype. These are the structural findings
 *  the inspection agent would have produced, and they give the tag graph its
 *  strongest edges -- Invoice to Monetary amounts sits at strength 1.0 because
 *  every invoice has figures and hardly anything else does. */
export const PATTERNS_BY_DOCTYPE: Record<string, string[]> = {
  invoice: ['money', 'invoice-number', 'amount-due', 'tax-id', 'table-row', 'percentage'],
  receipt: ['money', 'amount-due', 'table-row'],
  statement: ['money', 'accounting-period', 'iban', 'table-row', 'percentage'],
  contract: ['legalese', 'clause-numbering', 'signature-block', 'salutation'],
  policy: ['legalese', 'clause-numbering'],
  certificate: ['signature-block', 'national-id'],
  report: ['table-row', 'percentage', 'citation', 'url'],
  paper: ['citation', 'percentage', 'url'],
  presentation: ['url', 'percentage', 'table-row'],
  spreadsheet: ['table-row', 'percentage', 'money'],
  log: ['log-line', 'severity-level', 'stack-trace', 'ip-address'],
  'source-code': ['source-code', 'sql', 'url', 'credentials'],
  resume: ['email-address', 'phone-number', 'salutation', 'date-of-birth'],
  letter: ['salutation', 'signature-block', 'email-address'],
  'meeting-notes': ['attendees', 'action-items', 'url'],
  form: ['blank-field', 'national-id', 'date-of-birth'],
  manual: ['url', 'table-row'],
  proposal: ['money', 'percentage', 'url', 'table-row'],
  transcript: ['attendees', 'salutation'],
  screenshot: ['screenshot-name'],
  photo: ['sequence-name', 'version-name'],
  recording: ['sequence-name', 'version-name'],
};

/** A ~300-term keyword tail, drawn Zipf-style so document frequency has real
 *  range. Built from game/production vocabulary rather than lorem so the
 *  hover text reads like a real library. */
export const KEYWORD_POOL: string[] = [
  'lighting', 'rigging', 'shader', 'mesh', 'texture-atlas', 'lod', 'bake',
  'storyboard', 'moodboard', 'palette', 'thumbnail', 'silhouette', 'turnaround',
  'milestone', 'sprint', 'backlog', 'blocker', 'regression', 'hotfix', 'patch',
  'localisation', 'subtitle', 'dub', 'glossary', 'string-table',
  'budget', 'forecast', 'variance', 'reconciliation', 'accrual', 'invoice-run',
  'contract-renewal', 'indemnity', 'licence-term', 'royalty', 'clause',
  'onboarding', 'appraisal', 'headcount', 'contractor', 'timesheet',
  'trailer', 'teaser', 'keyart', 'press-kit', 'store-page', 'wishlist',
  'influencer', 'campaign-brief', 'media-buy', 'impressions', 'ctr',
  'playtest', 'telemetry', 'crash-dump', 'profiler', 'frame-time', 'memory-leak',
  'build-agent', 'artifact', 'pipeline', 'exporter', 'validator', 'checksum',
  'concept', 'greybox', 'whitebox', 'blockout', 'kitbash', 'photogrammetry',
  'ambience', 'foley', 'stinger', 'loop-point', 'mix-down', 'mastering',
  'motion-capture', 'retarget', 'blend-tree', 'state-machine', 'ik',
  'colour-grade', 'lut', 'composite', 'roto', 'matte', 'plate',
  'retrospective', 'postmortem', 'roadmap', 'scope-cut', 'greenlight',
  'certification', 'submission', 'age-rating', 'compliance', 'accessibility',
  'controller', 'keybind', 'ui-flow', 'wireframe', 'prototype', 'vertical-slice',
];
