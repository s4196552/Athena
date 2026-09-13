'use server';

import { revalidatePath } from 'next/cache';
import { writeTheme, isTheme, type ThemeChoice } from './store';

/* Recording the appearance choice.
 *
 * The toggle applies the change in the browser immediately, so this is not on
 * the path a viewer waits for -- it is what makes the choice survive the next
 * request, when the server stamps the attribute itself.
 */
export async function setThemeAction(choice: string): Promise<void> {
  const next: ThemeChoice = isTheme(choice) ? choice : 'system';
  await writeTheme(next);
  // The attribute lives on <html>, which the root layout renders, so the whole
  // tree is what has to be produced again.
  revalidatePath('/', 'layout');
}
