/** 再現性のための決定的な擬似乱数生成器（mulberry32）。 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 標準正規乱数（Box-Muller）。 */
export function makeGaussian(rng: () => number): () => number {
  let spare: number | null = null;
  return function next() {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = rng() * 2 - 1;
      v = rng() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * mul;
    return u * mul;
  };
}

/**
 * 0..n-1 から m 個を重複なく選ぶ（m < n）。
 * n が巨大でも O(m) メモリで済むよう、m が小さいときは棄却サンプリングを使う。
 */
export function sampleIndices(n: number, m: number, rng: () => number): Int32Array {
  if (m >= n) {
    const all = new Int32Array(n);
    for (let i = 0; i < n; i++) all[i] = i;
    return all;
  }
  if (m > n / 4) {
    // 部分 Fisher-Yates
    const idx = new Int32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    for (let i = 0; i < m; i++) {
      const j = i + Math.floor(rng() * (n - i));
      const t = idx[i];
      idx[i] = idx[j];
      idx[j] = t;
    }
    return idx.slice(0, m).sort();
  }
  const seen = new Set<number>();
  const out = new Int32Array(m);
  let filled = 0;
  while (filled < m) {
    const v = Math.floor(rng() * n);
    if (!seen.has(v)) {
      seen.add(v);
      out[filled++] = v;
    }
  }
  return out.sort();
}
