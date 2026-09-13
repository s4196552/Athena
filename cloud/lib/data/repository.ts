import type {
  User, UserId, Org, OrgId, Workspace, WorkspaceId, Library, LibraryId,
  LibraryGrant, FileRecord, FileId, TagId, TagRecord, SavedView, ColorGroupSet,
  GraphMode, LibraryGraph, OrgMembership, WorkspaceMembership,
} from './types';
import type { Overlay } from '../overlay/types';

/* THE DATA BOUNDARY.
 *
 * Everything above this line is domain vocabulary; everything below it is a
 * driver. The JSON driver reads committed fixtures; a future SQL driver runs
 * queries. Nothing that calls these methods should be able to tell which.
 *
 * Two rules keep that true:
 *
 *   1. Every method that reads catalogue data takes a WorkspaceContext first.
 *      Scope is applied inside the repository, never in a page, so a component
 *      cannot forget it and leak another workspace's files.
 *   2. Nothing here returns a driver-specific shape. When `applyScope` becomes
 *      a SQL WHERE fragment, these signatures do not move.
 */

/** Resolved once per request. `grants` are the workspace's, already loaded. */
export interface WorkspaceContext {
  userId: UserId;
  org: Org;
  workspace: Workspace;
  role: WorkspaceMembership['role'];
  grants: LibraryGrant[];
  /** This workspace's corrections and albums. Passed IN rather than fetched
   *  here, so the driver stays a pure function of its arguments and the store
   *  behind it (cookie today, a table later) is not baked into the boundary. */
  overlay: Overlay;
  /** Has this workspace suppressed this tag on this file? Precomputed, because
   *  it is asked once per tag per file on every listing. */
  isRemoved(fileId: FileId, tagId: TagId): boolean;
  /** Tags this workspace has ADDED to this file -- an accepted agent proposal,
   *  or anything else the workspace decided. Optional so a driver that has no
   *  overlay at all still satisfies the contract. */
  addedTags?(fileId: FileId): Set<TagId> | undefined;
  /** Effective permission: min(workspace role, grant access). */
  can(action: 'read' | 'tag' | 'manageGrants'): boolean;
}

/** Files per page when a query does not say otherwise.
 *
 *  Part of the contract rather than a driver's private constant, because the UI
 *  has to size a page control with it: "Previous" needs to know how far back a
 *  page is, and only the page that renders the control can ask. */
export const PAGE_SIZE = 120;

export interface FileQuery {
  /** Restrict to one granted library; omitted means all granted libraries. */
  libraryId?: LibraryId;
  /** kind -> names. OR within a kind, AND across kinds -- the desktop app's
   *  algebra, preserved so URLs are portable between the two. */
  tags?: Record<string, string[]>;
  /** Substring match on file name. */
  q?: string;
  /** Restrict to one album's members. Albums live in the overlay, so this is
   *  resolved against ctx rather than the catalogue. */
  albumId?: string;
  mediaType?: string;
  limit?: number;
  cursor?: string;
}

export interface FilePage {
  files: FileRecord[];
  total: number;
  nextCursor: string | null;
}

export interface FacetGroup {
  kind: string;
  label: string;
  values: { tagId: number; name: string; display: string; count: number }[];
}

export interface AthenaRepository {
  // --- identity -----------------------------------------------------------
  getUserById(id: UserId): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  listUsers(): Promise<User[]>;
  getOrgMemberships(userId: UserId): Promise<OrgMembership[]>;
  getWorkspaceMemberships(userId: UserId): Promise<WorkspaceMembership[]>;

  // --- tenancy ------------------------------------------------------------
  getOrg(id: OrgId): Promise<Org | null>;
  getOrgBySlug(slug: string): Promise<Org | null>;
  getWorkspaceBySlug(slug: string): Promise<Workspace | null>;
  /** Every workspace this user may enter, across every org. */
  listWorkspacesForUser(userId: UserId): Promise<Workspace[]>;
  listWorkspacesInOrg(orgId: OrgId): Promise<Workspace[]>;
  listMembersOfWorkspace(workspaceId: WorkspaceId): Promise<{ user: User; role: string }[]>;

  // --- libraries and grants -----------------------------------------------
  getLibrary(id: LibraryId): Promise<Library | null>;
  getLibraryBySlug(slug: string): Promise<Library | null>;
  listLibrariesOwnedBy(orgId: OrgId): Promise<Library[]>;
  listGrantsForWorkspace(workspaceId: WorkspaceId): Promise<LibraryGrant[]>;
  /** Who else can see this library, and through what scope. The sharing screen. */
  listGrantsForLibrary(libraryId: LibraryId): Promise<LibraryGrant[]>;
  /** How many files a given grant actually exposes. */
  countForGrant(grant: LibraryGrant): Promise<number>;

  // --- catalogue ----------------------------------------------------------
  buildContext(
    userId: UserId,
    workspaceSlug: string,
    overlay?: Overlay,
  ): Promise<WorkspaceContext | null>;
  listFiles(ctx: WorkspaceContext, query: FileQuery): Promise<FilePage>;
  getFile(ctx: WorkspaceContext, id: FileId): Promise<FileRecord | null>;
  listTags(ctx: WorkspaceContext, libraryId?: LibraryId): Promise<TagRecord[]>;
  facets(ctx: WorkspaceContext, query: FileQuery): Promise<FacetGroup[]>;
  /** Totals for the workspace overview. */
  summary(ctx: WorkspaceContext): Promise<{
    files: number; tags: number; bytes: number; libraries: number; mutations: number;
  }>;

  // --- graph --------------------------------------------------------------
  /** The precomputed file graph for one library, unfiltered. Callers induce
   *  the subgraph for a selection; they never recompute k-NN. */
  getLibraryGraph(ctx: WorkspaceContext, libraryId: LibraryId): Promise<LibraryGraph | null>;

  // --- per-workspace state ------------------------------------------------
  listSavedViews(ctx: WorkspaceContext): Promise<SavedView[]>;
  getColorGroups(ctx: WorkspaceContext, mode: GraphMode): Promise<ColorGroupSet | null>;
}
