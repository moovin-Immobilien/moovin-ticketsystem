// Ähnlichkeit Entwurf vs. gesendeter Text (0..1) auf Wortebene – Basis für die "unverändert übernommen"-Quote.
function tokens(s: string) {
  return s.toLowerCase().replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
}
export function similarity(a: string, b: string): number {
  const x = tokens(a), y = tokens(b);
  if (!x.length && !y.length) return 1;
  // Levenshtein auf Tokens (Texte sind kurz)
  const prev = new Array(y.length + 1).fill(0).map((_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (x[i - 1] === y[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}
export const UNCHANGED_THRESHOLD = 0.97;
