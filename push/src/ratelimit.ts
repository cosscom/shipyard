// Limits per phone key and per address, kept in the function's memory.
// That is a best effort: Vercel runs several instances, each with its own
// count, so the firewall's rules (README.md) are the hard limit per
// address, and these keep one busy key or address from using an instance
// up.

export interface Window {
  limit: number;
  ms: number;
}

export class Limiter {
  private hits = new Map<string, number[]>();
  private windows: Window[];
  private now: () => number;

  constructor(windows: Window[], now: () => number = Date.now) {
    this.windows = windows;
    this.now = now;
  }

  // take counts one for id, and says whether it is within every window.
  take(id: string): boolean {
    const now = this.now();
    const longest = Math.max(...this.windows.map((w) => w.ms));
    const kept = (this.hits.get(id) ?? []).filter((t) => now - t < longest);
    const ok = this.windows.every((w) => kept.filter((t) => now - t < w.ms).length < w.limit);
    if (ok) kept.push(now);
    this.hits.set(id, kept);
    // Forget ids that went quiet, so the map stays small.
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (!v.length || now - v[v.length - 1] >= longest) this.hits.delete(k);
    return ok;
  }
}
