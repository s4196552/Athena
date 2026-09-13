'use client';

import { useCallback, useSyncExternalStore } from 'react';

/* A single viewer preference, backed by localStorage.
 *
 * `useSyncExternalStore` rather than an effect, for the same reasons as
 * useStoredRules: no synchronous setState in an effect, a correct server
 * snapshot instead of a hydration mismatch, and cross-tab sync for free.
 *
 * These are per-viewer conveniences -- which view you last used, how big you
 * like the tiles. They are deliberately NOT workspace state: two people in the
 * same workspace should not fight over each other's zoom level.
 */

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

/* getSnapshot must be referentially stable for unchanged data or React loops
 * forever, so the parse is cached against the raw string. */
const cache = new Map<string, { raw: string; parsed: unknown }>();

function read<T>(key: string): T | undefined {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return undefined; // private mode, blocked storage
  }
  if (raw === null) {
    cache.delete(key);
    return undefined;
  }
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.parsed as T;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  cache.set(key, { raw, parsed });
  return parsed as T;
}

export function useLocalSetting<T>(key: string, fallback: T): [T, (next: T) => void] {
  const stored = useSyncExternalStore(
    subscribe,
    () => read<T>(key),
    () => undefined, // server render: always the fallback
  );

  const set = useCallback((next: T) => {
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Nothing to do; the setting just will not persist for this viewer.
    }
    emit();
  }, [key]);

  return [stored ?? fallback, set];
}
