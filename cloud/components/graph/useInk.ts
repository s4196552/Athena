'use client';

import { useEffect, useState } from 'react';
import { DARK_INK, type Ink } from './renderer';

/* The canvas's share of the palette.
 *
 * A <canvas> has no cascade. Everything the graph draws that is not a node's
 * own colour was a literal in renderer.ts, which is why the graph stayed dark
 * when the rest of the app gained a light appearance. These are now tokens in
 * globals.css, and this reads their computed values.
 *
 * Re-read on both of the things that can change them: the attribute the theme
 * toggle writes to <html>, and the system setting when no explicit choice has
 * been made.
 */

const KEYS: Record<keyof Ink, string> = {
  edge: '--canvas-edge',
  edgeFaint: '--canvas-edge-faint',
  edgeLit: '--canvas-edge-lit',
  ring: '--canvas-ring',
  label: '--canvas-label',
  band: '--canvas-band',
  bandMuted: '--canvas-band-muted',
  bandLabel: '--canvas-band-label',
};

function read(): Ink {
  const style = getComputedStyle(document.documentElement);
  const out = {} as Ink;
  for (const [field, token] of Object.entries(KEYS) as [keyof Ink, string][]) {
    // An empty string means the token is missing; falling back to the dark
    // value keeps the graph drawable rather than painting it with "".
    out[field] = style.getPropertyValue(token).trim() || DARK_INK[field];
  }
  return out;
}

export function useInk(): Ink {
  /* Starts at the dark set rather than reading during render: getComputedStyle
   * does not exist on the server, and a first paint with the wrong ink is
   * corrected on the same frame by the effect below. */
  const [ink, setInk] = useState<Ink>(DARK_INK);

  useEffect(() => {
    const apply = () => setInk(read());
    apply();

    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    const system = window.matchMedia('(prefers-color-scheme: light)');
    system.addEventListener?.('change', apply);

    return () => {
      observer.disconnect();
      system.removeEventListener?.('change', apply);
    };
  }, []);

  return ink;
}
