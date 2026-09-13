import Link from 'next/link';
import { signOutAction } from '@/app/(auth)/actions';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import s from './topbar.module.css';

interface Props {
  user: { name: string; email: string; avatarHue: number };
  workspace: { slug: string; name: string; accentHex: string };
  orgName: string;
  role: string;
  workspaces: { id: string; slug: string; name: string; accentHex: string; orgName: string }[];
}

export function TopBar({ user, workspace, orgName, role, workspaces }: Props) {
  const base = `/w/${workspace.slug}`;

  return (
    <header className={s.bar}>
      <Link href="/app" className={s.brand}>
        <span className={s.mark} aria-hidden="true" />
      </Link>

      <WorkspaceSwitcher current={workspace} orgName={orgName} role={role} workspaces={workspaces} />

      <nav className={s.nav}>
        <Link href={base} className={s.link}>Overview</Link>
        <Link href={`${base}/library`} className={s.link}>Library</Link>
        <Link href={`${base}/graph`} className={s.link}>Graph</Link>
        <Link href={`${base}/settings/colors`} className={s.link}>Colours</Link>
      </nav>

      <div className={s.right}>
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
