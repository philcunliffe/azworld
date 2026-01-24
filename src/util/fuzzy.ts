export function levenshtein(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const m = s.length;
  const n = t.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        dp[j]! + 1,
        dp[j - 1]! + 1,
        prev + cost
      );
      prev = tmp;
    }
  }
  return dp[n]!;
}

export function bestFuzzyMatch(query: string, candidates: string[], cutoff = 0.75): string | undefined {
  const q = (query || "").trim().toLowerCase();
  if (!q || candidates.length === 0) return undefined;

  let best: { cand: string; score: number } | undefined;
  for (const c of candidates) {
    const cc = c.toLowerCase();
    const maxLen = Math.max(q.length, cc.length);
    const dist = levenshtein(q, cc);
    const score = maxLen === 0 ? 1 : 1 - dist / maxLen;
    if (!best || score > best.score) best = { cand: c, score };
  }

  if (!best) return undefined;
  return best.score >= cutoff ? best.cand : undefined;
}
