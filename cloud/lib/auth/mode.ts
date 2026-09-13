/* Is this deployment running on fixture accounts?
 *
 * One constant, deliberately in its own file so it is impossible to change by
 * accident and obvious in a diff.
 *
 * While it is true:
 *   - /login is a picker over seeded accounts; there are no passwords and no
 *     sign-up, because there is nothing to authenticate;
 *   - the catalogue those accounts read is sample data committed to this
 *     repository, so nothing behind the session is private;
 *   - AUTH_SECRET is therefore optional. Sessions are still signed, with a
 *     built-in key when no secret is configured, so the cookie is not casually
 *     editable -- but forging one only gets you a different fixture identity
 *     looking at the same published sample, which the login page hands out on
 *     request anyway.
 *
 * SET IT TO FALSE THE MOMENT ACCOUNTS BECOME REAL -- that is, the moment
 * `provider` in ./index.ts is anything other than mockProvider. With it false,
 * an unset AUTH_SECRET throws at first use instead of falling back, because a
 * signing key committed to a public repository is a master key once the
 * identities behind it mean something.
 */
export const DEMO_AUTH = true;
