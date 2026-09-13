'use client';

import { useCallback, useSyncExternalStore } from 'react';

/* A CSS media query, readable from JavaScript.
 *
 * Needed because some of this app is not CSS. The graph's layout is a d3-force
 * simulation drawn to a <canvas> in a requestAnimationFrame loop, so the
 * blanket `prefers-reduced-motion` rule in globals.css -- which zeroes every
 * animation and transition duration -- cannot touch it. The single largest
 * moving surface in the app was therefore the one surface that ignored the
 * setting.
 *
 * `useSyncExternalStore` rather than an effect, matching useLocalSetting: the
 * server snapshot is explicit instead of being a hydration mismatch waiting to
 * happen, and a person who changes the setting while the page is open gets the
 * new behaviour without a reload.
 */

const SERVER = false;

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    // Not every engine that ships matchMedia ships addEventListener on the
    // result; Safari only gained it in 14.
    const list = window.matchMedia(query);
    if (list.addEventListener) {
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    }
    list.addListener(onChange);
    return () => list.removeListener(onChange);
  }, [query]);

  const get = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, get, () => SERVER);
}

/** True when the viewer has asked the system for less movement.
 *
 *  The HIG's guidance for this state is to replace motion with a change of
 *  state rather than to remove the feedback: "replacing transitions in x-, y-,
 *  and z-axes with fades to avoid motion". */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
