/* The domain model.
 *
 * Shapes are inherited from athena/db/schema.sql rather than invented. Where a
 * name differs from the SQL, the SQL name is given in a comment, because the
 * eventual SQL-backed repository has to map cleanly onto it.
 *
 * The one genuinely new idea is tenancy, and it turns on a single distinction:
 *
 *     a LIBRARY is a catalogue.        (the data)
 *     a WORKSPACE is a team.           (who looks at it)
 *     a GRANT is the edge between.     (what they may see of it)
 *
 * "Sharing a database" is therefore N grants on 1 library -- never a copy.
 * Copying would break the property the whole engine rests on: one `asset` row
 * per content hash. Two workspaces would end up disagreeing about the same
 * bytes, and the co-occurrence edges between departments would vanish.
 */

/** Branded ids. A workspace id and a library id are both strings at runtime;
 *  the brand stops them being swapped at compile time. Casting happens exactly
 *  once, in the JSON loader, so nothing above it needs an `as`. */
type Id<B extends string> = string & { readonly __brand: B };

export type UserId = Id<'user'>;
export type OrgId = Id<'org'>;
export type WorkspaceId = Id<'ws'>;
export type LibraryId = Id<'lib'>;
export type FileId = Id<'file'>;
export type TagId = number;

/** Mirrors the CHECK constraint on tag.kind in schema.sql:322-354. */
export type TagKind =
  | 'object' | 'scene' | 'place' | 'keyword' | 'topic' | 'entity' | 'genre'
  | 'camera' | 'language' | 'system' | 'author' | 'doctype' | 'date'
  | 'pattern' | 'custom' | 'user';

/** Mirrors asset.media_type. */
export type MediaType = 'image' | 'video' | 'audio' | 'document' | 'other';

// ---------------------------------------------------------------------------
//  Identity
// ---------------------------------------------------------------------------

export interface User {
  id: UserId;
  email: string;
  name: string;
  /** 0-359. Avatars are generated, not uploaded -- no asset hosting for a demo. */
  avatarHue: number;
  createdAt: number;
}

export interface Org {
  id: OrgId;
  slug: string;
  name: string;
  plan: 'demo';
}

export interface Workspace {
  id: WorkspaceId;
  orgId: OrgId;
  /** Globally unique, so routes are /w/hadesmedia-marketing rather than
   *  /w/hadesmedia/marketing. One segment, one lookup, no ambiguity. */
  slug: string;
  name: string;
  /** Tints the workspace chrome. Switching workspace has to be unmistakable at
   *  a glance, or sharing one library between two teams gets confusing fast. */
  accentHex: string;
  defaultLibraryId: LibraryId;
}

export type OrgRole = 'owner' | 'admin' | 'member' | 'guest';
export type WorkspaceRole = 'admin' | 'editor' | 'viewer';

export interface OrgMembership {
  userId: UserId;
  orgId: OrgId;
  role: OrgRole;
}

export interface WorkspaceMembership {
  userId: UserId;
  workspaceId: WorkspaceId;
  role: WorkspaceRole;
}

// ---------------------------------------------------------------------------
//  The catalogue
// ---------------------------------------------------------------------------

export interface Library {
  id: LibraryId;
  ownerOrgId: OrgId;
  slug: string;
  name: string;
  /** The folder that was indexed, e.g. "HadesMedia/". Corresponds to `root`. */
  rootLabel: string;
  fileCount: number;
  tagCount: number;
  assetCount: number;
  bytes: number;
  indexedAt: number;
  /** The guarantee, as a literal type. Athena never writes to indexed files;
   *  a catalogue reporting anything else would be a bug, not a state. */
  mutations: 0;
}

export type GrantAccess = 'read' | 'contribute' | 'manage';

/** What a workspace may see of a library. THIS is what "shared" means. */
export interface LibraryGrant {
  id: string;
  libraryId: LibraryId;
  workspaceId: WorkspaceId;
  /** 'contribute' permits user tags and saved views. It never permits mutating
   *  source files, because nothing in Athena does. */
  access: GrantAccess;
  /** An empty scope means the whole library. */
  scope: Scope;
  grantedBy: UserId;
  grantedAt: number;
  /** The workspace's default library, shown first and used when no library is
   *  named in the URL. */
  isPrimary: boolean;
}

/** Applied in the repository, before any user filter, so a page can never
 *  render a file the workspace was not granted. Follows the desktop app's
 *  filter algebra: OR within a field, AND across fields. */
export interface Scope {
  pathPrefixes?: string[];
  includeTags?: TagRef[];
  /** Exclusions win over inclusions. */
  excludeTags?: TagRef[];
  mediaTypes?: MediaType[];
}

export interface TagRef {
  kind: TagKind;
  name: string;
}

export interface TagRecord {
  id: TagId;
  libraryId: LibraryId;
  kind: TagKind;
  /** Normalised: lowercase, singular. UNIQUE(kind, name), as in the schema. */
  name: string;
  displayName: string;
  fileCount: number;
  /** ln(N / df), precomputed at seed time. Drives both edge weighting and the
   *  specificity cut that stops the file graph becoming a hairball. */
  idf: number;
}

export interface FileRecord {
  id: FileId;
  libraryId: LibraryId;
  /** BLAKE3 of the content. Duplicates share it -- that is the asset/file
   *  split from schema.sql:9-22, preserved. */
  assetId: string;
  relPath: string;
  parentRel: string;
  name: string;
  ext: string;
  sizeBytes: number;
  mtime: number;
  mediaType: MediaType;
  /** Stand-in for the dominant colour the desktop grid tints cards with. */
  tintHex?: string;
  /** How many paths hold this same content. */
  copies: number;
  /** Machine tags. Global: `doctype=invoice` is a fact about the content, so
   *  every workspace sharing this library sees the same value. */
  tags: TagId[];
  /** User tags (asset_tag.source = 'user'). Workspace-scoped:
   *  `custom=needs-legal-review` is an opinion a team holds, so Finance's
   *  annotations must not show up in Marketing's graph. The distinction falls
   *  straight out of the existing `source` column rather than being invented. */
  userTags?: { tagId: TagId; workspaceId: WorkspaceId }[];
}

// ---------------------------------------------------------------------------
//  Per-workspace state
// ---------------------------------------------------------------------------

export interface SavedView {
  id: string;
  workspaceId: WorkspaceId;
  name: string;
  /** Canonical query string, same parameter names the desktop app uses, so a
   *  link is portable between the two. */
  query: string;
  createdBy: UserId;
  createdAt: number;
}

export type GraphMode = 'files' | 'tags';

export type ColorQuery =
  | { type: 'tag'; kind: TagKind; name: string }
  | { type: 'kind'; kind: TagKind }
  | { type: 'path'; prefix: string }
  | { type: 'media'; mediaType: MediaType }
  | { type: 'ext'; ext: string }
  | { type: 'text'; q: string }
  | { type: 'untagged' };

export interface ColorRule {
  id: string;
  label: string;
  /** Hex. */
  color: string;
  query: ColorQuery;
  enabled: boolean;
}

/** Ordered. Top of the list wins; first enabled match assigns the colour. The
 *  ordering IS the precedence rule, which is why the editor is drag-sortable:
 *  the rule is visible rather than documented. */
export interface ColorGroupSet {
  workspaceId: WorkspaceId;
  mode: GraphMode;
  rules: ColorRule[];
  updatedAt: number;
}

// ---------------------------------------------------------------------------
//  The seed file shapes
// ---------------------------------------------------------------------------

export interface TenancySeed {
  users: User[];
  orgs: Org[];
  workspaces: Workspace[];
  orgMemberships: OrgMembership[];
  workspaceMemberships: WorkspaceMembership[];
  libraries: Library[];
  grants: LibraryGrant[];
  savedViews: SavedView[];
  colorGroups: ColorGroupSet[];
}

/** Precomputed at seed time by scripts/build-graph.mts. Shipping a LAYOUT and
 *  not merely a graph is the highest-leverage decision in the whole design:
 *  the first paint is already structured, so there is no untangling animation
 *  and the client simulation becomes optional rather than load-bearing. */
export interface LibraryGraph {
  /** Parallel to `nodes`: file ids in node-index order. */
  ids: FileId[];
  /** Degree per node, clamped to 255. Drives node radius. */
  degree: number[];
  /** World-space coordinates, quantised to 1/8 unit as Int16 at rest. */
  x: number[];
  y: number[];
  /** Flat [src, tgt, src, tgt, ...] node indices. */
  edges: number[];
  /** Similarity per edge, 0..255. */
  weights: number[];
}
