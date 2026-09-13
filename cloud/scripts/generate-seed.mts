/* Generates the committed catalogue under cloud/data/seed/.
 *
 * Deterministic: same PRNG seed in, byte-identical JSON out. The seed is a
 * checked-in artifact, so a generator that shuffled on every run would make
 * every regeneration a 7,000-line diff and hide real changes in the noise.
 *
 *   npm run seed      (this, then scripts/build-graph.mts)
 *
 * Reads nothing from athena/ -- the taxonomy is mirrored in lib/taxonomy.ts and
 * kept honest by `npm run check:taxonomy`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32, int, pick, weighted, sample, chance, zipf, type Rng } from './lib/rng.mts';
import {
  FOLDERS, MEDIA_BY_EXT, BYTES_BY_EXT, doctypeFor, PATTERNS_BY_DOCTYPE,
  KEYWORD_POOL, type FolderSpec,
} from './lib/folders.mts';
import { DOCTYPES, TOPICS, PATTERNS, GAMES, TEAM_MEMBERS, humanName, displayFor } from '../lib/taxonomy.ts';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'data', 'seed');

// ---------------------------------------------------------------------------
//  Tuning
// ---------------------------------------------------------------------------

/** Share of files that get only base-rate tags (a year and a generic doctype),
 *  so their best similarity falls under threshold and they end up with zero
 *  edges. These become the ring of unconnected nodes orbiting the perimeter.
 *  That rim is the visual signature of an Obsidian graph, so it is generated
 *  on purpose rather than tolerated as an accident. */
const ORPHAN_SHARE = 0.06;

/** Share of files whose topic is drawn from a *different* folder's
 *  distribution. Without crossover the clusters are disconnected islands;
 *  this is what creates the bridges between them. */
const CROSSOVER = 0.15;

const YEAR_WEIGHTS: Record<string, number> = {
  '2022': 0.15, '2023': 0.22, '2024': 0.31, '2025': 0.32,
};

const TINTS = ['#3d5a80', '#5c4b73', '#7a4b3f', '#3f6b5a', '#6b5d3f', '#4a4a5e', '#734b5e'];

// ---------------------------------------------------------------------------
//  Tag registry
// ---------------------------------------------------------------------------

interface TagRow {
  id: number; kind: string; name: string; displayName: string;
  fileCount: number; idf: number;
}

class TagRegistry {
  private byKey = new Map<string, TagRow>();
  private next = 1;

  intern(kind: string, name: string, displayName?: string): number {
    const key = `${kind}:${name}`;
    let row = this.byKey.get(key);
    if (!row) {
      row = {
        id: this.next++, kind, name,
        displayName: displayName ?? name,
        fileCount: 0, idf: 0,
      };
      this.byKey.set(key, row);
    }
    return row.id;
  }

  countAll(files: { tags: number[] }[]): void {
    const counts = new Map<number, number>();
    for (const f of files) {
      // A file may carry a tag once only; dedupe defensively so fileCount is a
      // document frequency and not a term frequency.
      for (const t of new Set(f.tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const n = files.length;
    for (const row of this.byKey.values()) {
      row.fileCount = counts.get(row.id) ?? 0;
      row.idf = row.fileCount > 0 ? Math.log(n / row.fileCount) : 0;
    }
  }

  rows(): TagRow[] {
    return [...this.byKey.values()]
      .filter((r) => r.fileCount > 0)
      .sort((a, b) => a.id - b.id);
  }
}

// ---------------------------------------------------------------------------
//  File generation
// ---------------------------------------------------------------------------

interface FileRow {
  id: string; libraryId: string; assetId: string;
  relPath: string; parentRel: string; name: string; ext: string;
  sizeBytes: number; mtime: number; mediaType: string;
  tintHex?: string; copies: number; tags: number[];
}

function hex(rng: Rng, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += '0123456789abcdef'[Math.floor(rng() * 16)];
  return s;
}

function slugWord(rng: Rng): string {
  return KEYWORD_POOL[zipf(rng, KEYWORD_POOL.length)].replace(/-/g, '_');
}

function makeName(
  rng: Rng, sub: string, game: string | null, ext: string,
  doctype: string, year: string,
): string {
  const seq = String(int(rng, 1, 480)).padStart(3, '0');
  const g = game ? game.toLowerCase() : null;

  if (doctype === 'invoice') return `INV-${year}-${String(int(rng, 1, 9999)).padStart(4, '0')}.${ext}`;
  if (doctype === 'receipt') return `receipt_${year}${String(int(rng, 1, 12)).padStart(2, '0')}_${seq}.${ext}`;
  if (doctype === 'statement') return `statement_${year}_Q${int(rng, 1, 4)}.${ext}`;
  if (doctype === 'contract') return `contract_${slugWord(rng)}_${year}_signed.${ext}`;
  if (doctype === 'resume') return `CV_${pick(rng, TEAM_MEMBERS).replace(/\./g, '_')}.${ext}`;
  if (doctype === 'log') return `${sub.toLowerCase()}_agent${int(rng, 1, 12)}_${year}${seq}.${ext}`;
  if (doctype === 'meeting-notes') return `notes_${slugWord(rng)}_${year}-${String(int(rng, 1, 12)).padStart(2, '0')}.${ext}`;
  if (doctype === 'screenshot') return `Screenshot_${year}-${String(int(rng, 1, 12)).padStart(2, '0')}-${String(int(rng, 1, 28)).padStart(2, '0')}_${seq}.${ext}`;

  const stem = g
    ? `${g}_${slugWord(rng)}_${seq}`
    : `${sub.toLowerCase()}_${slugWord(rng)}_${seq}`;
  const version = chance(rng, 0.35)
    ? `_v${int(rng, 0, 3)}.${int(rng, 0, 9)}`
    : '';
  return `${stem}${version}.${ext}`;
}

function generateLibrary(
  libraryId: string, folders: FolderSpec[], total: number, seed: number,
): { files: FileRow[]; tags: TagRegistry } {
  const rng = mulberry32(seed);
  const tags = new TagRegistry();
  const files: FileRow[] = [];

  // Pre-intern the vocabularies so ids are stable regardless of draw order.
  for (const t of TOPICS) tags.intern('topic', t.name, t.display);
  for (const d of DOCTYPES) tags.intern('doctype', d.name, d.display);
  for (const p of PATTERNS) tags.intern('pattern', p.name, p.display);
  for (const g of GAMES) tags.intern('entity', g, g.replace(/_/g, ' '));
  for (const a of TEAM_MEMBERS) tags.intern('author', a, humanName(a));
  for (const y of Object.keys(YEAR_WEIGHTS)) tags.intern('date', y, y);

  const totalShare = folders.reduce((s, f) => s + f.share, 0);
  const allTopics = TOPICS.map((t) => t.name);

  let n = 0;
  for (const spec of folders) {
    const count = Math.round((spec.share / totalShare) * total);

    for (let i = 0; i < count && n < total; i++, n++) {
      // --- where it lives
      const game = spec.perGame ? pick(rng, GAMES) : null;
      const sub = spec.subs ? pick(rng, spec.subs) : (game ?? 'General');
      const parentRel = spec.path + (game ? `${game}/` : '') + (spec.subs ? `${sub}/` : '');

      // --- what it is
      const ext = weighted(rng, spec.exts);
      const mediaType = MEDIA_BY_EXT[ext] ?? 'other';
      const year = weighted(rng, YEAR_WEIGHTS);
      const isOrphan = chance(rng, ORPHAN_SHARE);

      const fileTags: number[] = [tags.intern('date', year)];

      if (isOrphan) {
        // Only base-rate tags. Both are far above the specificity cut, so the
        // edge builder will refuse every candidate and this node lands on the
        // rim with degree zero.
        const generic = mediaType === 'audio' || mediaType === 'video'
          ? 'recording'
          : mediaType === 'image' ? 'photo' : 'report';
        fileTags.push(tags.intern('doctype', generic));

        files.push(makeRow(rng, libraryId, parentRel, sub, game, ext, generic, year, mediaType, fileTags));
        continue;
      }

      // --- topic, conditioned on the folder (with crossover)
      const topic = chance(rng, CROSSOVER)
        ? pick(rng, allTopics)
        : weighted(rng, spec.topics);
      fileTags.push(tags.intern('topic', topic));

      // --- doctype, conditioned on extension AND topic
      const doctype = weighted(rng, doctypeFor(ext, topic));
      fileTags.push(tags.intern('doctype', doctype));

      // --- author, with folder affinity
      if (spec.authors && chance(rng, 0.9)) {
        fileTags.push(tags.intern('author', weighted(rng, spec.authors)));
        if (chance(rng, 0.18)) fileTags.push(tags.intern('author', pick(rng, TEAM_MEMBERS)));
      } else if (chance(rng, 0.5)) {
        fileTags.push(tags.intern('author', pick(rng, TEAM_MEMBERS)));
      }

      // --- entity
      if (game) fileTags.push(tags.intern('entity', game));
      else if (chance(rng, 0.12)) fileTags.push(tags.intern('entity', pick(rng, GAMES)));

      // --- patterns, conditioned strictly on doctype
      const pool = PATTERNS_BY_DOCTYPE[doctype] ?? [];
      if (pool.length) {
        for (const p of sample(rng, pool, int(rng, 1, Math.min(3, pool.length)))) {
          fileTags.push(tags.intern('pattern', p));
        }
      }

      // --- keywords, Zipf-drawn so document frequency has a long tail
      const kn = int(rng, 1, 3);
      for (let k = 0; k < kn; k++) {
        const w = KEYWORD_POOL[zipf(rng, KEYWORD_POOL.length)];
        fileTags.push(tags.intern('keyword', w, w.replace(/-/g, ' ')));
      }

      files.push(makeRow(rng, libraryId, parentRel, sub, game, ext, doctype, year, mediaType, fileTags));
    }
  }

  tags.countAll(files);
  return { files, tags };
}

function makeRow(
  rng: Rng, libraryId: string, parentRel: string, sub: string, game: string | null,
  ext: string, doctype: string, year: string, mediaType: string, fileTags: number[],
): FileRow {
  const name = makeName(rng, sub, game, ext, doctype, year);
  const [lo, hi] = BYTES_BY_EXT[ext] ?? [1000, 500_000];
  const month = int(rng, 0, 11);
  const day = int(rng, 1, 28);

  return {
    id: `f_${hex(rng, 10)}`,
    libraryId,
    // ~4% of files share content with another, which is what gives the
    // duplicate view something to show -- one asset, several paths.
    assetId: hex(rng, 32),
    relPath: parentRel + name,
    parentRel,
    name,
    ext,
    sizeBytes: int(rng, lo, hi),
    mtime: Date.UTC(Number(year), month, day, int(rng, 8, 19), int(rng, 0, 59)),
    mediaType,
    tintHex: mediaType === 'image' || mediaType === 'video' ? pick(rng, TINTS) : undefined,
    copies: 1,
    tags: [...new Set(fileTags)],
  };
}

// ---------------------------------------------------------------------------
//  Tenancy
// ---------------------------------------------------------------------------

const now = Date.UTC(2026, 0, 15);

const users = [
  { id: 'u_ada', email: 'ada@hadesmedia.example', name: 'Ada Reyes', avatarHue: 265, createdAt: now },
  { id: 'u_tomas', email: 'tomas@hadesmedia.example', name: 'Tomas Ek', avatarHue: 38, createdAt: now },
  { id: 'u_priya', email: 'priya@hadesmedia.example', name: 'Priya Raman', avatarHue: 170, createdAt: now },
  { id: 'u_iris', email: 'iris@hadesmedia.example', name: 'Iris Okafor', avatarHue: 210, createdAt: now },
  { id: 'u_sam', email: 'sam@hermes.example', name: 'Sam Delacroix', avatarHue: 95, createdAt: now },
  { id: 'u_nils', email: 'nils@hermes.example', name: 'Nils Bergstrom', avatarHue: 320, createdAt: now },
];

const orgs = [
  { id: 'o_hades', slug: 'hadesmedia', name: 'HadesMedia', plan: 'demo' as const },
  { id: 'o_hermes', slug: 'hermes', name: 'Hermes Media', plan: 'demo' as const },
];

const libraries = [
  {
    id: 'l_main', ownerOrgId: 'o_hades', slug: 'hadesmedia-main',
    name: 'HadesMedia Master Catalogue', rootLabel: 'HadesMedia/',
    fileCount: 0, tagCount: 0, assetCount: 0, bytes: 0, indexedAt: now, mutations: 0 as const,
  },
  {
    id: 'l_vault', ownerOrgId: 'o_hades', slug: 'hadesmedia-brand-vault',
    name: 'Brand Vault', rootLabel: 'BrandVault/',
    fileCount: 0, tagCount: 0, assetCount: 0, bytes: 0, indexedAt: now, mutations: 0 as const,
  },
  {
    id: 'l_hermes', ownerOrgId: 'o_hermes', slug: 'hermes-archive',
    name: 'Hermes Archive', rootLabel: 'HermesMedia/',
    fileCount: 0, tagCount: 0, assetCount: 0, bytes: 0, indexedAt: now, mutations: 0 as const,
  },
];

const workspaces = [
  { id: 'w_mkt', orgId: 'o_hades', slug: 'hadesmedia-marketing', name: 'Marketing', accentHex: '#ff8fc2', defaultLibraryId: 'l_main' },
  { id: 'w_fin', orgId: 'o_hades', slug: 'hadesmedia-finance', name: 'Finance', accentHex: '#ffc861', defaultLibraryId: 'l_main' },
  { id: 'w_ops', orgId: 'o_hades', slug: 'hadesmedia-ops', name: 'Studio Ops', accentHex: '#56d3c8', defaultLibraryId: 'l_main' },
  { id: 'w_pub', orgId: 'o_hermes', slug: 'hermes-publishing', name: 'Publishing', accentHex: '#c3a8ff', defaultLibraryId: 'l_hermes' },
];

const orgMemberships = [
  { userId: 'u_ada', orgId: 'o_hades', role: 'admin' as const },
  { userId: 'u_tomas', orgId: 'o_hades', role: 'member' as const },
  { userId: 'u_priya', orgId: 'o_hades', role: 'member' as const },
  { userId: 'u_iris', orgId: 'o_hades', role: 'owner' as const },
  { userId: 'u_priya', orgId: 'o_hermes', role: 'guest' as const },
  { userId: 'u_sam', orgId: 'o_hermes', role: 'owner' as const },
  { userId: 'u_nils', orgId: 'o_hermes', role: 'member' as const },
];

const workspaceMemberships = [
  { userId: 'u_ada', workspaceId: 'w_mkt', role: 'admin' as const },
  { userId: 'u_iris', workspaceId: 'w_mkt', role: 'viewer' as const },
  { userId: 'u_tomas', workspaceId: 'w_fin', role: 'admin' as const },
  { userId: 'u_iris', workspaceId: 'w_ops', role: 'admin' as const },
  // Priya is in BOTH Marketing and Finance. That pair is the whole reason the
  // workspace switcher is worth having: the same person, the same library,
  // two different scopes and two different sets of colours.
  { userId: 'u_priya', workspaceId: 'w_mkt', role: 'editor' as const },
  { userId: 'u_priya', workspaceId: 'w_fin', role: 'viewer' as const },
  { userId: 'u_priya', workspaceId: 'w_pub', role: 'viewer' as const },
  { userId: 'u_sam', workspaceId: 'w_pub', role: 'admin' as const },
  { userId: 'u_nils', workspaceId: 'w_pub', role: 'editor' as const },
];

const grants = [
  // The user's example, modelled literally: HadesMedia Marketing and
  // HadesMedia Finance both hold a grant on l_main. One library, two lenses.
  {
    id: 'g_mkt_main', libraryId: 'l_main', workspaceId: 'w_mkt', access: 'contribute' as const,
    scope: {
      pathPrefixes: [
        'Marketing_Assets/', 'Brand_Identity/', 'Video/',
        'Photography_and_Reference/', 'Art_Assets/',
      ],
    },
    grantedBy: 'u_iris', grantedAt: now, isPrimary: true,
  },
  {
    id: 'g_fin_main', libraryId: 'l_main', workspaceId: 'w_fin', access: 'contribute' as const,
    scope: {
      pathPrefixes: ['Documents/', '_Archive/', '_Shared/'],
      includeTags: [
        { kind: 'topic' as const, name: 'finance' },
        { kind: 'topic' as const, name: 'legal' },
        { kind: 'topic' as const, name: 'operations' },
        { kind: 'topic' as const, name: 'hr' },
      ],
    },
    grantedBy: 'u_iris', grantedAt: now, isPrimary: true,
  },
  {
    id: 'g_ops_main', libraryId: 'l_main', workspaceId: 'w_ops', access: 'manage' as const,
    scope: {},
    grantedBy: 'u_iris', grantedAt: now, isPrimary: true,
  },
  {
    id: 'g_mkt_vault', libraryId: 'l_vault', workspaceId: 'w_mkt', access: 'contribute' as const,
    scope: {}, grantedBy: 'u_iris', grantedAt: now, isPrimary: false,
  },
  {
    id: 'g_pub_hermes', libraryId: 'l_hermes', workspaceId: 'w_pub', access: 'manage' as const,
    scope: {}, grantedBy: 'u_sam', grantedAt: now, isPrimary: true,
  },
  // Cross-org. Proves the model is not merely an intra-org convenience.
  {
    id: 'g_pub_vault', libraryId: 'l_vault', workspaceId: 'w_pub', access: 'read' as const,
    scope: {}, grantedBy: 'u_iris', grantedAt: now, isPrimary: false,
  },
];

/** User tags are workspace-scoped: `custom=needs-legal-review` is an opinion a
 *  team holds, not a fact about the bytes. Same library, visibly different
 *  "My tags" axis -- the sharing story told in one screenshot. */
const CUSTOM_TAGS: Record<string, string[]> = {
  w_mkt: ['hero-shot', 'approved', 'q4-campaign', 'needs-retouch', 'press-ready'],
  w_fin: ['needs-legal-review', 'reconciled', 'fy24', 'disputed', 'audit-trail'],
  w_ops: ['blocked', 'archive-candidate', 'duplicate-suspect'],
  w_pub: ['licensed', 'embargoed'],
};

// ---------------------------------------------------------------------------
//  Build
// ---------------------------------------------------------------------------

const brandFolders = FOLDERS.filter((f) =>
  f.path.startsWith('Brand_Identity/') || f.path.startsWith('Marketing_Assets/'));

const plan = [
  { lib: libraries[0], folders: FOLDERS, count: 6120, seed: 0x5EED_A711 },
  { lib: libraries[1], folders: brandFolders, count: 380, seed: 0x5EED_B00C },
  { lib: libraries[2], folders: FOLDERS, count: 1240, seed: 0x5EED_C0DE },
];

mkdirSync(OUT, { recursive: true });

const summary: string[] = [];

for (const { lib, folders, count, seed } of plan) {
  const { files, tags } = generateLibrary(lib.id, folders, count, seed);
  const rng = mulberry32(seed ^ 0xABCD);

  // --- workspace-scoped user tags, applied through the grants on this library
  const wsWithGrant = grants.filter((g) => g.libraryId === lib.id).map((g) => g.workspaceId);
  const userTagIds = new Map<string, Map<string, number>>();
  for (const ws of wsWithGrant) {
    const m = new Map<string, number>();
    for (const name of CUSTOM_TAGS[ws] ?? []) {
      m.set(name, tags.intern('custom', name, name.replace(/-/g, ' ')));
    }
    userTagIds.set(ws, m);
  }

  const withUserTags = files.map((f) => {
    const ut: { tagId: number; workspaceId: string }[] = [];
    for (const ws of wsWithGrant) {
      if (!chance(rng, 0.12)) continue;
      const names = CUSTOM_TAGS[ws] ?? [];
      if (!names.length) continue;
      const name = pick(rng, names);
      ut.push({ tagId: userTagIds.get(ws)!.get(name)!, workspaceId: ws });
    }
    return ut.length ? { ...f, userTags: ut } : f;
  });

  // Recount including the custom tags so the facet rail shows real numbers.
  tags.countAll(
    withUserTags.map((f) => ({
      tags: [...f.tags, ...((f as { userTags?: { tagId: number }[] }).userTags ?? []).map((u) => u.tagId)],
    })),
  );

  const tagRows = tags.rows();
  const bytes = withUserTags.reduce((s, f) => s + f.sizeBytes, 0);

  lib.fileCount = withUserTags.length;
  lib.tagCount = tagRows.length;
  lib.assetCount = new Set(withUserTags.map((f) => f.assetId)).size;
  lib.bytes = bytes;

  const dir = join(OUT, 'libraries', lib.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(lib, null, 2));
  writeFileSync(join(dir, 'tags.json'), JSON.stringify(tagRows));
  writeFileSync(join(dir, 'files.json'), JSON.stringify(withUserTags));

  const orphans = withUserTags.filter((f) => f.tags.length <= 2).length;
  summary.push(
    `  ${lib.slug.padEnd(24)} ${String(lib.fileCount).padStart(5)} files, ` +
    `${String(tagRows.length).padStart(4)} tags, ` +
    `${orphans} base-rate-only (${((orphans / lib.fileCount) * 100).toFixed(1)}%)`,
  );
}

// --- default colour groups, seeded per workspace so Marketing and Finance
//     visibly colour the same library differently on first load.
const topicColors: Record<string, string> = {
  finance: '#ffc861', legal: '#b48cff', hr: '#7ee0a3', engineering: '#5aa9ff',
  marketing: '#ff8fc2', sales: '#ff9f5a', research: '#56d3c8', medical: '#ff6f6f',
  education: '#d9d15e', operations: '#8fb6c9', security: '#e35d8a',
  personal: '#b9e06a', travel: '#6fd0ff', design: '#cfa0ff',
};

/** Rule order IS precedence, so the caller's array order is the whole input. */
function fileRules(order: string[]) {
  return order.map((t) => ({
    id: `r_${t}`,
    label: displayFor(TOPICS, t),
    color: topicColors[t],
    query: { type: 'tag' as const, kind: 'topic' as const, name: t },
    enabled: true,
  }));
}

/** Tag-mode defaults come straight from KIND_COLOUR in
 *  athena/web/static/app.js, so a tag graph here looks like the same graph in
 *  the desktop app. */
const tagRules = [
  { id: 'r_topic', label: 'Topic', color: '#6fb2ff', query: { type: 'kind' as const, kind: 'topic' as const }, enabled: true },
  { id: 'r_doctype', label: 'Kind', color: '#ffc861', query: { type: 'kind' as const, kind: 'doctype' as const }, enabled: true },
  { id: 'r_author', label: 'Author', color: '#8ee6a1', query: { type: 'kind' as const, kind: 'author' as const }, enabled: true },
  { id: 'r_custom', label: 'My tag', color: '#ff9ecb', query: { type: 'kind' as const, kind: 'custom' as const }, enabled: true },
  { id: 'r_entity', label: 'Named', color: '#c3a8ff', query: { type: 'kind' as const, kind: 'entity' as const }, enabled: true },
  { id: 'r_pattern', label: 'Contains', color: '#9fd0c0', query: { type: 'kind' as const, kind: 'pattern' as const }, enabled: true },
  { id: 'r_date', label: 'Year', color: '#7d8b9c', query: { type: 'kind' as const, kind: 'date' as const }, enabled: true },
];

const colorGroups = [
  { workspaceId: 'w_mkt', mode: 'files' as const, rules: fileRules(['marketing', 'design', 'sales', 'operations', 'engineering', 'legal', 'research', 'finance']), updatedAt: now },
  { workspaceId: 'w_fin', mode: 'files' as const, rules: fileRules(['finance', 'legal', 'operations', 'hr', 'sales', 'marketing', 'engineering', 'research']), updatedAt: now },
  { workspaceId: 'w_ops', mode: 'files' as const, rules: fileRules(['engineering', 'design', 'operations', 'marketing', 'finance', 'legal', 'hr', 'security']), updatedAt: now },
  { workspaceId: 'w_pub', mode: 'files' as const, rules: fileRules(['marketing', 'design', 'operations', 'legal', 'finance', 'research', 'engineering', 'sales']), updatedAt: now },
  ...workspaces.map((w) => ({ workspaceId: w.id, mode: 'tags' as const, rules: tagRules, updatedAt: now })),
];

const savedViews = [
  { id: 'v_1', workspaceId: 'w_fin', name: 'Unpaid invoices 2025', query: 'doctype=invoice&date=2025', createdBy: 'u_tomas', createdAt: now },
  { id: 'v_2', workspaceId: 'w_fin', name: 'Contracts up for renewal', query: 'doctype=contract&topic=legal', createdBy: 'u_tomas', createdAt: now },
  { id: 'v_3', workspaceId: 'w_mkt', name: 'Key art, press-ready', query: 'custom=press-ready&type=image', createdBy: 'u_ada', createdAt: now },
  { id: 'v_4', workspaceId: 'w_mkt', name: 'Vortex Rising campaign', query: 'entity=Vortex_Rising&topic=marketing', createdBy: 'u_ada', createdAt: now },
  { id: 'v_5', workspaceId: 'w_ops', name: 'Everything 2025', query: 'date=2025', createdBy: 'u_iris', createdAt: now },
];

writeFileSync(
  join(OUT, 'tenancy.json'),
  JSON.stringify({
    users, orgs, workspaces, orgMemberships, workspaceMemberships,
    libraries, grants, savedViews, colorGroups,
  }, null, 2),
);

console.log('seed written to cloud/data/seed/');
for (const line of summary) console.log(line);
console.log(
  `  ${'tenancy'.padEnd(24)} ${orgs.length} orgs, ${workspaces.length} workspaces, ` +
  `${users.length} users, ${grants.length} grants`,
);
