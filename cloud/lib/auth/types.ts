import type { User, UserId, OrgId, WorkspaceId } from '../data/types';

export interface Session {
  user: User;
  /** The active workspace, if one has been chosen. Null right after sign-in
   *  when the user belongs to several and has not picked yet. */
  orgId: OrgId | null;
  workspaceId: WorkspaceId | null;
  expiresAt: number;
}

export interface SignUpInput {
  email: string;
  name: string;
  password: string;
}

export type AuthResult =
  | { ok: true; session: Session }
  | { ok: false; error: string };

/* What a provider must implement.
 *
 * Deliberately small: three methods, no session handling, no cookies, no
 * redirects. Those live in lib/auth/index.ts and stay the same whichever
 * provider is plugged in, which is what makes the swap a one-line change.
 */
export interface AuthProvider {
  verifyCredentials(email: string, password?: string): Promise<User | null>;
  createUser(input: SignUpInput): Promise<User>;
  loadUser(id: UserId): Promise<User | null>;
  /** For the demo chips on the login screen. A real provider returns []. */
  demoUsers(): Promise<User[]>;
}
