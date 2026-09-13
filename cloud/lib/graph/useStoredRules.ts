'use client';

import { useCallback, useSyncExternalStore } from 'react';
import type { ColorRule } from '../data/types';

/* Colour rules, backed by localStorage.
 *
 * localStorage is an external store, so this is `useSyncExternalStore` rather
 * than an effect that reads it after mount. Three things fall out of doing it
 * properly: no synchronous setState in an effect (and so no cascading render),
 * a correct server snapshot instead of a hydration mismatch, and cross-tab
 * sync for free -- editing the palette in one tab updates the graph in another.
 *
 * Why localStorage at all: the catalogue ships as a committed file and Vercel's
 * filesystem is read-only at runtime, so there is nowhere on the server to save
 * a per-viewer palette. The repository interface already has the seam
 * (getColorGroups / saveColorGroups) for when there is.
 */

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // 'storage' fires for OTHER tabs; the local set is covered by emit().
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

/* getSnapshot must return a referentially stable value for unchanged data, or
 * React re-renders forever. Cache the parse, keyed by the raw string. */
const cache = new Map<string, { raw: string; parsed: ColorRule[] | null }>();

function read(key: string): ColorRule[] | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    // Private mode, or site data blocked. Seeded defaults are a fine fallback.
    return null;
  }
  if (raw === null) {
    cache.delete(key);
    return null;
  }
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.parsed;

  let parsed: ColorRule[] | null = null;
  try {
    const value = JSON.parse(raw);
    if (Array.isArray(value)) parsed = value as ColorRule[];
  } catch {
    parsed = null;
  }
  cache.set(key, { raw, parsed });
  return parsed;
}

export interface StoredRules {
  rules: ColorRule[];
  /** True when this viewer has edited away from the seeded defaults. */
  dirty: boolean;
  save: (next: ColorRule[]) => void;
  reset: () => void;
}

export function useStoredRules(key: string, initial: ColorRule[]): StoredRules {
  const stored = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => null, // server render: always the seeded defaults
  );

  const save = useCallback((next: ColorRule[]) => {
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Nothing to do -- the view still works for this session.
    }
    emit();
  }, [key]);

  const reset = useCallback(() => {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
    emit();
  }, [key]);

  return { rules: stored ?? initial, dirty: stored !== null, save, reset };
}
