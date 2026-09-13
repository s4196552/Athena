'use server';

import { redirect } from 'next/navigation';
import { signIn, signUp, signOut, switchWorkspace } from '@/lib/auth';
import type { WorkspaceId } from '@/lib/data/types';

export interface FormState {
  error?: string;
}

/** `next` is carried through the form so signing in returns you to the page
 *  you actually asked for, rather than dumping you on a dashboard. */
function safeNext(raw: FormDataEntryValue | null): string | null {
  const value = typeof raw === 'string' ? raw : '';
  // Only same-origin paths. Without this check, `?next=https://evil.example`
  // turns the login form into an open redirect.
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  return value;
}

export async function signInAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const next = safeNext(formData.get('next'));

  const result = await signIn(email, password);
  if (!result.ok) return { error: result.error };

  redirect(next ?? (result.session.workspaceId ? '/app' : '/app/select'));
}

export async function signUpAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const result = await signUp({
    email: String(formData.get('email') ?? ''),
    name: String(formData.get('name') ?? ''),
    password: String(formData.get('password') ?? ''),
  });
  if (!result.ok) return { error: result.error };
  redirect('/app/select');
}

export async function signOutAction(): Promise<void> {
  await signOut();
  redirect('/');
}

export async function switchWorkspaceAction(formData: FormData): Promise<void> {
  const id = String(formData.get('workspaceId') ?? '') as WorkspaceId;
  const ok = await switchWorkspace(id);
  redirect(ok ? '/app' : '/app/select');
}
