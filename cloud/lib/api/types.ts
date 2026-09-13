/* The wire contract between Athena Cloud and anything that is not a browser.
 *
 * This module is the whole reason the CLI is written in TypeScript. A client
 * and its server drifting apart is the ordinary way a CLI rots: a field gets
 * renamed in a route, the client keeps reading the old name, and the symptom
 * is a column that silently prints `undefined` rather than an error anyone
 * notices. Here the routes and the CLI import the SAME interfaces, so that
 * rename is a type error in both places at once.
 *
 * Deliberately free of `server-only` and of any import that reaches the
 * repository: the CLI loads this file in a plain Node process. It is types and
 * two constants, nothing that can run.
 *
 * Versioned in the path (`/api/v1/...`) rather than by a header. A CLI is
 * installed once and used for a long time, so the day this contract changes
 * shape is the day an old client needs to keep working -- and a path is the
 * one form of versioning that is visible in a log, a bug report and a curl
 * command someone pastes into an issue.
 */

export const API_VERSION = 'v1';
export const API_BASE = `/api/${API_VERSION}`;

/** Every non-2xx answer from every route has this shape, so a client needs one
 *  error path rather than one per endpoint. `hint` carries the "what to do
 *  about it" half, which the UI equivalents already put in their messages. */
export interface ApiError {
  error: string;
  hint?: string;
}

// ---------------------------------------------------------------------------
//  Identity
// ---------------------------------------------------------------------------

export interface ApiWorkspace {
  slug: string;
  name: string;
  role: string;
  /** What this workspace can see, after its grants and its overlay. */
  files: number;
  tags: number;
}

export interface MeResponse {
  user: { id: string; name: string; email: string };
  workspaces: ApiWorkspace[];
  expiresAt: number;
}

/** Published only while the deployment runs on fixture accounts. See
 *  lib/auth/mode.ts — with real accounts this endpoint 404s rather than
 *  enumerating users. */
export interface AccountsResponse {
  accounts: { email: string; name: string; workspaces: string[] }[];
  passwordRequired: boolean;
}

export interface LoginRequest {
  email: string;
  /** Ignored while the deployment runs on fixture accounts, required the
   *  moment it does not. See lib/auth/mode.ts. */
  password?: string;
}

// ---------------------------------------------------------------------------
//  The catalogue
// ---------------------------------------------------------------------------

export interface ApiTag {
  kind: string;
  name: string;
  display: string;
  /** True for a tag this workspace added itself, machine-assigned otherwise. */
  user?: boolean;
}

export interface ApiFile {
  id: string;
  name: string;
  relPath: string;
  parentRel: string;
  ext: string;
  mediaType: string;
  sizeBytes: number;
  /** Epoch milliseconds. Formatting is the client's problem, and a client in
   *  another timezone must not be handed a string that has already guessed. */
  mtime: number;
  tags: ApiTag[];
}

export interface FilesResponse {
  /** Every file matching the filter, not just this page. */
  total: number;
  offset: number;
  /** Pass back as `cursor` for the next page. Absent on the last one. */
  nextCursor?: string;
  files: ApiFile[];
  /** The filter as the server understood it, canonicalised. Echoed so a client
   *  can show what it actually asked for -- a mistyped axis silently matching
   *  nothing is otherwise indistinguishable from an empty library. */
  filter: Record<string, string>;
}

export interface FacetValue {
  name: string;
  display: string;
  count: number;
}

export interface FacetsResponse {
  axes: { kind: string; label: string; values: FacetValue[] }[];
}

export interface ApiRelation {
  fileId: string;
  name: string;
  relPath: string;
  /** Cosine similarity over idf-weighted tag vectors, 0..1. */
  score: number;
  shared: { name: string; display: string; kind: string }[];
  sameFolder: boolean;
}

export interface FileDetailResponse {
  file: ApiFile;
  /** Tags the catalogue holds that this workspace has chosen not to count. */
  removed: ApiTag[];
  related: ApiRelation[];
}

// ---------------------------------------------------------------------------
//  The agent
// ---------------------------------------------------------------------------

export interface BriefResponse {
  title: string;
  /** Markdown, in the closed grammar lib/brief/compile.ts emits. */
  body: string;
  intro?: string;
  themes?: string[];
  about?: string[];
  /** "counted" when no model was involved, otherwise the model's id. */
  producedBy: string;
  note?: string;
  files: number;
}

export interface AskResponse {
  question: string;
  mode: 'files' | 'tags' | 'pyramid';
  title: string;
  why: string;
  /** Axis -> tag names, exactly as the catalogue spells them. */
  tags: Record<string, string[]>;
  q?: string;
  /** Names the model asked for that this library does not have. */
  dropped: { axis: string; name: string }[];
  /** Counted by the repository, never reported by the model. */
  matches: number;
  /** Absolute paths on the server, for a client that wants to open a browser. */
  graphPath: string;
  libraryPath: string;
  model: string;
}

export interface ExplainResponse {
  summary: string;
  reads: string[];
  /** What could not be determined without opening the file. Never empty. */
  unknowns: string[];
  confidence: 'high' | 'medium' | 'low';
  model: string;
}
