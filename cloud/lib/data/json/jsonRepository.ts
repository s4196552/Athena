import 'server-only';
import { tenancy, library, libraryGraph } from './load';
import { applyScope } from './scope';
import { PAGE_SIZE } from '../repository';
import type {
  AthenaRepository, WorkspaceContext, FileQuery, FilePage, FacetGroup,
} from '../repository';
import type {
  User, UserId, Org, OrgId, Workspace, WorkspaceId, Library, LibraryId,
  LibraryGrant, FileRecord, FileId, TagId, TagRecord, GraphMode, WorkspaceRole,
} from '../types';
import { emptyOverlay, removalIndex } from '../../overlay/types';
import type { Overlay } from '../../overlay/types';
import { TAG_AXES } from '../../taxonomy';

/* The JSON driver.
 *
 * Everything is in memory after first parse, so the "queries" are array
 * operations. They are written to mirror what the SQL versions will do -- scope
 * first, then filter, then page -- rather than to be clever, because the point
 * of this file is to be replaceable.
 */


function ranks(role: WorkspaceRole): number {
  return { viewer: 1, editor: 2, admin: 3 }[role];
}

function grantRank(access: LibraryGrant['access']): number {
  return { read: 1, contribute: 2, manage: 3 }[access];
}

class JsonRepository implements AthenaRepository {
  // --- identity -----------------------------------------------------------

  async getUserById(id: UserId) {
    return tenancy().users.find((u) => u.id === id) ?? null;
  }

  async getUserByEmail(email: string) {
    const lower = email.trim().toLowerCase();
    return tenancy().users.find((u) => u.email.toLowerCase() === lower) ?? null;
  }

  async listUsers(): Promise<User[]> {
    return tenancy().users;
  }

  async getOrgMemberships(userId: UserId) {
    return tenancy().orgMemberships.filter((m) => m.userId === userId);
  }

  async getWorkspaceMemberships(userId: UserId) {
    return tenancy().workspaceMemberships.filter((m) => m.userId === userId);
  }

  // --- tenancy ------------------------------------------------------------

  async getOrg(id: OrgId): Promise<Org | null> {
    return tenancy().orgs.find((o) => o.id === id) ?? null;
  }

  async getOrgBySlug(slug: string): Promise<Org | null> {
    return tenancy().orgs.find((o) => o.slug === slug) ?? null;
  }

  async getWorkspaceBySlug(slug: string): Promise<Workspace | null> {
    return tenancy().workspaces.find((w) => w.slug === slug) ?? null;
  }

  async listWorkspacesForUser(userId: UserId): Promise<Workspace[]> {
    const ids = new Set(
      tenancy().workspaceMemberships.filter((m) => m.userId === userId).map((m) => m.workspaceId),
    );
    return tenancy().workspaces.filter((w) => ids.has(w.id));
  }

  async listWorkspacesInOrg(orgId: OrgId): Promise<Workspace[]> {
    return tenancy().workspaces.filter((w) => w.orgId === orgId);
  }

  async listMembersOfWorkspace(workspaceId: WorkspaceId) {
    const t = tenancy();
    return t.workspaceMemberships
      .filter((m) => m.workspaceId === workspaceId)
      .map((m) => ({ user: t.users.find((u) => u.id === m.userId)!, role: m.role }))
      .filter((r) => r.user);
  }

  // --- libraries and grants -----------------------------------------------

  async getLibrary(id: LibraryId): Promise<Library | null> {
    return tenancy().libraries.find((l) => l.id === id) ?? null;
  }

  async getLibraryBySlug(slug: string): Promise<Library | null> {
    return tenancy().libraries.find((l) => l.slug === slug) ?? null;
  }

  async listLibrariesOwnedBy(orgId: OrgId): Promise<Library[]> {
    return tenancy().libraries.filter((l) => l.ownerOrgId === orgId);
  }

  async listGrantsForWorkspace(workspaceId: WorkspaceId): Promise<LibraryGrant[]> {
    return tenancy().grants.filter((g) => g.workspaceId === workspaceId);
  }

  async listGrantsForLibrary(libraryId: LibraryId): Promise<LibraryGrant[]> {
    return tenancy().grants.filter((g) => g.libraryId === libraryId);
  }

  async countForGrant(grant: LibraryGrant): Promise<number> {
    const bundle = library(grant.libraryId);
    return applyScope(bundle.files, grant.scope, bundle.tagById).length;
  }

  // --- catalogue ----------------------------------------------------------

  async buildContext(
    userId: UserId,
    workspaceSlug: string,
    overlay?: Overlay,
  ): Promise<WorkspaceContext | null> {
    const t = tenancy();
    const workspace = t.workspaces.find((w) => w.slug === workspaceSlug);
    if (!workspace) return null;

    const membership = t.workspaceMemberships.find(
      (m) => m.userId === userId && m.workspaceId === workspace.id,
    );
    // Not a member: report absence, not refusal. Saying "forbidden" would
    // confirm that another tenant's workspace exists at this slug.
    if (!membership) return null;

    const org = t.orgs.find((o) => o.id === workspace.orgId);
    if (!org) return null;

    const grants = t.grants.filter((g) => g.workspaceId === workspace.id);
    const bestGrant = Math.max(0, ...grants.map((g) => grantRank(g.access)));
    const roleRank = ranks(membership.role);

    /* An overlay belonging to a DIFFERENT workspace is discarded rather than
       applied. The cookie is per workspace and the caller reads the right one,
       but this is the boundary where getting it wrong would show Finance's
       corrections inside Marketing, so it is checked here too. */
    const own = overlay && overlay.workspaceId === workspace.id
      ? overlay
      : emptyOverlay(workspace.id);
    const removed = removalIndex(own);

    return {
      userId,
      org,
      workspace,
      role: membership.role,
      grants,
      overlay: own,
      isRemoved(fileId: FileId, tagId: TagId) {
        return removed.get(fileId)?.has(tagId) ?? false;
      },
      can(action) {
        // Effective permission is the lesser of what the role allows and what
        // the grant allows. A workspace admin still cannot tag a library that
        // was only shared read-only.
        const effective = Math.min(roleRank, bestGrant);
        if (action === 'read') return effective >= 1;
        if (action === 'tag') return effective >= 2;
        return roleRank >= 3 && bestGrant >= 3;
      },
    };
  }

  /** Every file this workspace may see, across every library it holds a grant
   *  on, scope already applied. The single chokepoint for tenancy. */
  private visible(ctx: WorkspaceContext, libraryId?: LibraryId): FileRecord[] {
    const grants = libraryId
      ? ctx.grants.filter((g) => g.libraryId === libraryId)
      : ctx.grants;

    const out: FileRecord[] = [];
    for (const g of grants) {
      const bundle = library(g.libraryId);
      out.push(...applyScope(bundle.files, g.scope, bundle.tagById));
    }
    return out;
  }

  /** Tags visible to this workspace: machine tags plus this workspace's own
   *  user tags. Another workspace's `custom` tags are invisible by
   *  construction -- they are attached with a workspaceId and filtered here. */
  private tagIdsOf(f: FileRecord, ctx: WorkspaceContext): number[] {
    const workspaceId = ctx.workspace.id;
    const own = f.userTags?.filter((u) => u.workspaceId === workspaceId).map((u) => u.tagId) ?? [];
    const all = own.length ? [...f.tags, ...own] : f.tags;

    /* THE chokepoint. Removals are applied here and nowhere else, which is why
       a suppressed tag disappears from the facet counts, from the filter
       algebra, from the summary and from both graph modes without any of them
       knowing the feature exists. */
    if (!ctx.overlay.removals.length) return all;
    const kept = all.filter((id) => !ctx.isRemoved(f.id, id));
    return kept.length === all.length ? all : kept;
  }

  private matches(
    f: FileRecord,
    ctx: WorkspaceContext,
    query: FileQuery,
    albumMembers?: Set<string> | null,
  ): boolean {
    if (albumMembers && !albumMembers.has(f.id)) return false;
    if (query.mediaType && f.mediaType !== query.mediaType) return false;
    if (query.q && !f.name.toLowerCase().includes(query.q.toLowerCase())) return false;

    if (query.tags) {
      const bundle = library(f.libraryId);
      const ids = this.tagIdsOf(f, ctx);
      // OR within a kind, AND across kinds.
      for (const [kind, names] of Object.entries(query.tags)) {
        if (!names.length) continue;
        const hit = ids.some((id) => {
          const t = bundle.tagById.get(id);
          return t?.kind === kind && names.includes(t.name);
        });
        if (!hit) return false;
      }
    }
    return true;
  }

  /** An album names files, not a query, so membership is a set lookup. A
   *  missing album yields an empty set rather than the whole library: a
   *  deleted album must not silently widen the selection. */
  private albumMembers(ctx: WorkspaceContext, albumId?: string): Set<string> | null {
    if (!albumId) return null;
    const album = ctx.overlay.albums.find((a) => a.id === albumId);
    return new Set(album?.fileIds ?? []);
  }

  async listFiles(ctx: WorkspaceContext, query: FileQuery): Promise<FilePage> {
    const members = this.albumMembers(ctx, query.albumId);
    const all = this.visible(ctx, query.libraryId)
      .filter((f) => this.matches(f, ctx, query, members));
    const limit = query.limit ?? PAGE_SIZE;
    const start = query.cursor ? Number(query.cursor) : 0;
    const slice = all.slice(start, start + limit);
    return {
      files: slice,
      total: all.length,
      nextCursor: start + limit < all.length ? String(start + limit) : null,
    };
  }

  async getFile(ctx: WorkspaceContext, id: FileId): Promise<FileRecord | null> {
    // Looked up through `visible` rather than by id directly, so a guessed id
    // from another workspace's library returns null rather than a record.
    return this.visible(ctx).find((f) => f.id === id) ?? null;
  }

  async listTags(ctx: WorkspaceContext, libraryId?: LibraryId): Promise<TagRecord[]> {
    const ids = libraryId
      ? [libraryId]
      : [...new Set(ctx.grants.map((g) => g.libraryId))];
    const out: TagRecord[] = [];
    for (const id of ids) out.push(...library(id).tags);
    return out;
  }

  async facets(ctx: WorkspaceContext, query: FileQuery): Promise<FacetGroup[]> {
    const members = this.albumMembers(ctx, query.albumId);
    const files = this.visible(ctx, query.libraryId)
      .filter((f) => this.matches(f, ctx, query, members));

    const counts = new Map<number, number>();
    for (const f of files) {
      for (const id of this.tagIdsOf(f, ctx)) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }

    const tagById = new Map<number, TagRecord>();
    for (const id of new Set(ctx.grants.map((g) => g.libraryId))) {
      for (const t of library(id).tags) tagById.set(t.id, t);
    }

    return TAG_AXES.map(({ kind, label }) => ({
      kind,
      label,
      values: [...counts.entries()]
        .map(([tagId, count]) => ({ tag: tagById.get(tagId), tagId, count }))
        .filter((r) => r.tag?.kind === kind)
        .map((r) => ({
          tagId: r.tagId,
          name: r.tag!.name,
          display: r.tag!.displayName,
          count: r.count,
        }))
        .sort((a, b) => b.count - a.count || a.display.localeCompare(b.display))
        .slice(0, 16),
    })).filter((g) => g.values.length > 0);
  }

  async summary(ctx: WorkspaceContext) {
    const files = this.visible(ctx);
    const tagIds = new Set<number>();
    for (const f of files) for (const t of this.tagIdsOf(f, ctx)) tagIds.add(t);
    return {
      files: files.length,
      tags: tagIds.size,
      bytes: files.reduce((s, f) => s + f.sizeBytes, 0),
      libraries: new Set(ctx.grants.map((g) => g.libraryId)).size,
      // The guarantee, carried through from the engine.
      mutations: 0,
    };
  }

  // --- graph --------------------------------------------------------------

  async getLibraryGraph(ctx: WorkspaceContext, libraryId: LibraryId) {
    if (!ctx.grants.some((g) => g.libraryId === libraryId)) return null;
    return libraryGraph(libraryId);
  }

  // --- per-workspace state ------------------------------------------------

  async listSavedViews(ctx: WorkspaceContext) {
    return tenancy().savedViews.filter((v) => v.workspaceId === ctx.workspace.id);
  }

  async getColorGroups(ctx: WorkspaceContext, mode: GraphMode) {
    return tenancy().colorGroups.find(
      (c) => c.workspaceId === ctx.workspace.id && c.mode === mode,
    ) ?? null;
  }
}

export const jsonRepository: AthenaRepository = new JsonRepository();
