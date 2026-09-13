import Link from 'next/link';
import { signOutAction } from '@/app/(auth)/actions';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { NavLinks } from './NavLinks';
import { ThemeToggle } from './ThemeToggle';
import { readTheme } from '@/lib/theme/store';
import s from './topbar.module.css';

interface Props {
  user: { name: string; email: string; avatarHue: number };
  workspace: { slug: string; name: string; accentHex: string };
  orgName: string;
  role: string;
  workspaces: { id: string; slug: string; name: string; accentHex: string; orgName: string }[];
}

export async function TopBar({ user, workspace, orgName, role, workspaces }: Props) {
  const base = `/w/${workspace.slug}`;
  const theme = await readTheme();

  return (
    <header className={s.bar}>
      {/* Icon-only, so the name is carried by the label rather than by the
          glyph -- a screen reader otherwise announces this as just "link". */}
      <Link href="/app" className={s.brand} aria-label="Athena — all workspaces">
        <span className={s.mark} aria-hidden="true" />
      </Link>

      <WorkspaceSwitcher current={workspace} orgName={orgName} role={role} workspaces={workspaces} />

      <NavLinks base={base} />

      <div className={s.right}>
        <ThemeToggle choice={theme} />
        <span className={s.who} title={user.email}>
          <span
            className={s.avatar}
            style={{ background: `hsl(${user.avatarHue} 55% 42%)` }}
            aria-hidden="true"
          />
          {user.name}
        </span>
        <form action={signOutAction}>
          <button className={s.signout} type="submit">Sign out</button>
        </form>
      </div>
    </header>
  );
}
