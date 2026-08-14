import { makeGaussian, makeRng } from '../src/core/rng.ts';

/** 分離した k 個のガウス塊を作る */
export function makeBlobs(
  pointsPerBlob: number,
  blobs: number,
  d: number,
  spread: number,
  seed = 1,
): { x: Float32Array; truth: Int32Array; n: number } {
  const rng = makeRng(seed);
  const gauss = makeGaussian(rng);
  const n = pointsPerBlob * blobs;
  const x = new Float32Array(n * d);
  const truth = new Int32Array(n);
  const centers = new Float64Array(blobs * d);
  for (let b = 0; b < blobs; b++) {
    for (let j = 0; j < d; j++) centers[b * d + j] = gauss() * spread;
  }
  let idx = 0;
  for (let b = 0; b < blobs; b++) {
    for (let p = 0; p < pointsPerBlob; p++) {
      for (let j = 0; j < d; j++) x[idx * d + j] = centers[b * d + j] + gauss();
      truth[idx] = b;
      idx++;
    }
  }
  return { x, truth, n };
}

/** Adjusted Rand Index（クラスタリング結果と正解ラベルの一致度） */
export function adjustedRandIndex(a: Int32Array, b: Int32Array): number {
  const n = a.length;
  const pairs = new Map<string, number>();
  const aCount = new Map<number, number>();
  const bCount = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const key = `${a[i]}|${b[i]}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
    aCount.set(a[i], (aCount.get(a[i]) ?? 0) + 1);
    bCount.set(b[i], (bCount.get(b[i]) ?? 0) + 1);
  }
  const comb2 = (v: number) => (v * (v - 1)) / 2;
  let sumIJ = 0;
  for (const v of pairs.values()) sumIJ += comb2(v);
  let sumA = 0;
  for (const v of aCount.values()) sumA += comb2(v);
  let sumB = 0;
  for (const v of bCount.values()) sumB += comb2(v);
  const total = comb2(n);
  const expected = (sumA * sumB) / total;
  const max = (sumA + sumB) / 2;
  return max - expected === 0 ? 1 : (sumIJ - expected) / (max - expected);
}
