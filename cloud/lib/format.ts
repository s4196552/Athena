/** "1 file" / "6,120 files" — the desktop app pluralises counts the same way. */
export function formatCount(n: number, noun: string, plural?: string): string {
  const word = n === 1 ? noun : (plural ?? `${noun}s`);
  return `${n.toLocaleString()} ${word}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}
