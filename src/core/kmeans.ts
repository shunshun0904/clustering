import { makeRng, sampleIndices } from './rng.ts';

/**
 * k-means（k-means++ 初期化 + Lloyd 法、大規模時はミニバッチで初期化を高速化）。
 * X は行優先の n×d Float32Array。
 */

export interface KMeansResult {
  centers: Float64Array; // k×d
  labels: Int32Array; // n
  inertia: number;
  iterations: number;
}

/** 1 点と 1 中心の二乗距離 */
function sqDist(x: Float32Array, xi: number, c: Float64Array, ci: number, d: number): number {
  let sum = 0;
  for (let j = 0; j < d; j++) {
    const diff = x[xi + j] - c[ci + j];
    sum += diff * diff;
  }
  return sum;
}

/** k-means++ による初期中心の選択 */
export function kmeansPlusPlus(
  x: Float32Array,
  n: number,
  d: number,
  k: number,
  rng: () => number,
): Float64Array {
  const centers = new Float64Array(k * d);
  const first = Math.floor(rng() * n);
  for (let j = 0; j < d; j++) centers[j] = x[first * d + j];

  const closest = new Float64Array(n);
  for (let i = 0; i < n; i++) closest[i] = sqDist(x, i * d, centers, 0, d);

  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < n; i++) total += closest[i];
    let target = rng() * total;
    let chosen = n - 1;
    if (total <= 0) {
      chosen = Math.floor(rng() * n);
    } else {
      for (let i = 0; i < n; i++) {
        target -= closest[i];
        if (target <= 0) {
          chosen = i;
          break;
        }
      }
    }
    const base = c * d;
    for (let j = 0; j < d; j++) centers[base + j] = x[chosen * d + j];
    for (let i = 0; i < n; i++) {
      const dist = sqDist(x, i * d, centers, base, d);
      if (dist < closest[i]) closest[i] = dist;
    }
  }
  return centers;
}

/**
 * 全点を最近傍中心に割り当てる。
 * ||x-c||^2 = ||x||^2 - 2 x·c + ||c||^2 を使い、点ごとに ||x||^2 を省略する。
 */
export function assign(
  x: Float32Array,
  n: number,
  d: number,
  centers: Float64Array,
  k: number,
  labels: Int32Array,
): number {
  const centerNormHalf = new Float64Array(k);
  for (let c = 0; c < k; c++) {
    let sum = 0;
    const base = c * d;
    for (let j = 0; j < d; j++) sum += centers[base + j] * centers[base + j];
    centerNormHalf[c] = sum * 0.5;
  }
  let inertia = 0;
  for (let i = 0; i < n; i++) {
    const xi = i * d;
    let bestScore = Infinity;
    let best = 0;
    let selfNorm = 0;
    for (let j = 0; j < d; j++) selfNorm += x[xi + j] * x[xi + j];
    for (let c = 0; c < k; c++) {
      const base = c * d;
      let dot = 0;
      for (let j = 0; j < d; j++) dot += x[xi + j] * centers[base + j];
      const score = centerNormHalf[c] - dot;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    labels[i] = best;
    inertia += selfNorm + 2 * bestScore;
  }
  return Math.max(0, inertia);
}

/** Lloyd 法の反復 */
export function lloyd(
  x: Float32Array,
  n: number,
  d: number,
  k: number,
  initialCenters: Float64Array,
  maxIter = 60,
  tol = 1e-5,
): KMeansResult {
  const centers = initialCenters.slice();
  const labels = new Int32Array(n);
  const sums = new Float64Array(k * d);
  const counts = new Float64Array(k);
  let inertia = 0;
  let iterations = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    iterations = iter + 1;
    inertia = assign(x, n, d, centers, k, labels);

    sums.fill(0);
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const c = labels[i];
      counts[c]++;
      const base = c * d;
      const xi = i * d;
      for (let j = 0; j < d; j++) sums[base + j] += x[xi + j];
    }

    // 空クラスタは最も遠い点で置き換える
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) continue;
      let worst = 0;
      let worstDist = -1;
      for (let i = 0; i < n; i++) {
        const dist = sqDist(x, i * d, centers, labels[i] * d, d);
        if (dist > worstDist) {
          worstDist = dist;
          worst = i;
        }
      }
      const from = labels[worst];
      if (counts[from] > 1) {
        counts[from]--;
        const fromBase = from * d;
        for (let j = 0; j < d; j++) sums[fromBase + j] -= x[worst * d + j];
        labels[worst] = c;
        counts[c] = 1;
        const base = c * d;
        for (let j = 0; j < d; j++) sums[base + j] = x[worst * d + j];
      }
    }

    let shift = 0;
    for (let c = 0; c < k; c++) {
      const base = c * d;
      const cnt = counts[c] || 1;
      for (let j = 0; j < d; j++) {
        const next = sums[base + j] / cnt;
        const diff = next - centers[base + j];
        shift += diff * diff;
        centers[base + j] = next;
      }
    }
    if (shift <= tol) break;
  }

  inertia = assign(x, n, d, centers, k, labels);
  return { centers, labels, inertia, iterations };
}

/**
 * ミニバッチ k-means。数十万行でも数秒で収束する。
 * 最後に全点への割り当てを 1 回行う。
 */
export function miniBatchKMeans(
  x: Float32Array,
  n: number,
  d: number,
  k: number,
  initialCenters: Float64Array,
  batchSize = 4096,
  maxIter = 150,
  seed = 42,
): KMeansResult {
  const centers = initialCenters.slice();
  const counts = new Float64Array(k);
  const rng = makeRng(seed);
  const batchLabels = new Int32Array(batchSize);
  const batch = new Float32Array(batchSize * d);

  for (let iter = 0; iter < maxIter; iter++) {
    for (let b = 0; b < batchSize; b++) {
      const src = Math.floor(rng() * n) * d;
      const dst = b * d;
      for (let j = 0; j < d; j++) batch[dst + j] = x[src + j];
    }
    assign(batch, batchSize, d, centers, k, batchLabels);
    for (let b = 0; b < batchSize; b++) {
      const c = batchLabels[b];
      counts[c]++;
      const eta = 1 / counts[c];
      const base = c * d;
      const src = b * d;
      for (let j = 0; j < d; j++) {
        centers[base + j] = (1 - eta) * centers[base + j] + eta * batch[src + j];
      }
    }
  }

  const labels = new Int32Array(n);
  const inertia = assign(x, n, d, centers, k, labels);
  return { centers, labels, inertia, iterations: maxIter };
}

export interface KMeansOptions {
  seed?: number;
  restarts?: number;
  maxIter?: number;
  /** この行数を超えたらミニバッチで粗く合わせてから Lloyd で仕上げる */
  miniBatchThreshold?: number;
}

/** 行数に応じて手法を切り替える k-means */
export function kmeans(
  x: Float32Array,
  n: number,
  d: number,
  k: number,
  options: KMeansOptions = {},
): KMeansResult {
  const seed = options.seed ?? 42;
  const restarts = options.restarts ?? (n > 50000 ? 1 : 3);
  const maxIter = options.maxIter ?? 60;
  const miniBatchThreshold = options.miniBatchThreshold ?? 50000;

  if (k >= n) {
    const centers = new Float64Array(k * d);
    const labels = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      labels[i] = i;
      for (let j = 0; j < d; j++) centers[i * d + j] = x[i * d + j];
    }
    return { centers, labels, inertia: 0, iterations: 0 };
  }

  let best: KMeansResult | null = null;
  for (let r = 0; r < restarts; r++) {
    const rng = makeRng(seed + r * 7919);
    // 初期化は最大 2 万点のサンプルで（k-means++ は O(n k d)）
    const initSampleSize = Math.min(n, 20000);
    let init: Float64Array;
    if (initSampleSize < n) {
      const idx = sampleIndices(n, initSampleSize, rng);
      const sub = new Float32Array(initSampleSize * d);
      for (let i = 0; i < initSampleSize; i++) {
        const src = idx[i] * d;
        const dst = i * d;
        for (let j = 0; j < d; j++) sub[dst + j] = x[src + j];
      }
      init = kmeansPlusPlus(sub, initSampleSize, d, k, rng);
    } else {
      init = kmeansPlusPlus(x, n, d, k, rng);
    }

    let result: KMeansResult;
    if (n > miniBatchThreshold) {
      const coarse = miniBatchKMeans(x, n, d, k, init, 4096, 120, seed + r);
      result = lloyd(x, n, d, k, coarse.centers, Math.min(maxIter, 15));
    } else {
      result = lloyd(x, n, d, k, init, maxIter);
    }
    if (!best || result.inertia < best.inertia) best = result;
  }
  return best!;
}
