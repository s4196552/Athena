import 'server-only';
import { getRepository } from '../../data';
import type { AuthProvider, SignUpInput } from '../types';
import type { User, UserId } from '../../data/types';

/* The mock provider. THE ONLY FILE THAT KNOWS AUTHENTICATION IS FAKE.
 *
 * Any password is accepted for a seeded email. That is a deliberate demo
 * affordance, not an oversight, and the login screen says so in plain words
 * rather than implying a real check happened.
 *
 * Sign-ups live in a module-level map, which means they survive exactly as
 * long as the server process. On Vercel that is one warm lambda -- so a new
 * account can vanish between two requests. The signup screen states this too.
 * Pretending otherwise would produce the worst kind of demo bug: one that
 * looks like data loss.
 */

const created = new Map<string, User>();

export const mockProvider: AuthProvider = {
  async verifyCredentials(email: string): Promise<User | null> {
    const lower = email.trim().toLowerCase();
    const seeded = await getRepository().getUserByEmail(lower);
    if (seeded) return seeded;
    return created.get(lower) ?? null;
  },

  async createUser(input: SignUpInput): Promise<User> {
    const email = input.email.trim().toLowerCase();

    const existing = await this.verifyCredentials(email);
    if (existing) throw new Error('An account with that email already exists.');

    const user: User = {
      id: `u_new_${created.size + 1}` as UserId,
      email,
      name: input.name.trim() || email.split('@')[0],
      // Derived from the email so the same person gets the same avatar colour
      // on every process, which makes the demo look less arbitrary.
      avatarHue: [...email].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7),
      createdAt: Date.now(),
    };
    created.set(email, user);
    return user;
  },

  async loadUser(id: UserId): Promise<User | null> {
    const seeded = await getRepository().getUserById(id);
    if (seeded) return seeded;
    for (const u of created.values()) if (u.id === id) return u;
    return null;
  },

  async demoUsers(): Promise<User[]> {
    return getRepository().listUsers();
  },
};
