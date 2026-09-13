import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

/* eslint-config-next 16 ships flat configs directly -- no FlatCompat needed. */
const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,

  /* The two architectural boundaries, enforced rather than documented.
   *
   * Both exist so a swap stays a one-line change. Without these rules the
   * first person in a hurry imports a driver directly and the boundary is
   * quietly gone -- the kind of rot that stays invisible until the swap is
   * attempted and turns out to touch forty files. */
  {
    files: ['app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: ['**/lib/auth/providers/*', '@/lib/auth/providers/*'],
            message:
              'Import from @/lib/auth instead. Providers are private to the auth boundary, '
              + 'so swapping in NextAuth or Clerk stays a one-line change.',
          },
          {
            group: ['**/lib/data/json/jsonRepository', '@/lib/data/json/jsonRepository'],
            message:
              'Call getRepository() from @/lib/data instead. Importing a driver directly '
              + 'defeats the repository boundary, and pulls the 2 MB seed into whatever '
              + 'bundle does it.',
          },
        ],
      }],
    },
  },

  { ignores: ['.next/**', 'node_modules/**', 'data/seed/**'] },
];

export default eslintConfig;
