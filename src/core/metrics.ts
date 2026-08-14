/** クラスタリングの評価指標。 */

/**
 * シルエット係数。全点で計算すると O(n^2) なのでサンプルで近似する。
 * -1〜1 で、0.2 を超えれば実用的な分離、0.5 以上ならはっきり分かれている。
 */
export function silhouetteScore(
  x: Float32Array,
  d: number,
  labels: Int32Array,
  sampleIdx: Int32Array,
  k: number,
): number {
  const m = sampleIdx.length;
  if (m < 3 || k < 2) return 0;

  const clusterCount = new Int32Array(k);
  for (let i = 0; i < m; i++) clusterCount[labels[sampleIdx[i]]]++;
  let nonEmpty = 0;
  for (let c = 0; c < k; c++) if (clusterCount[c] > 0) nonEmpty++;
  if (nonEmpty < 2) return 0;

  const sums = new Float64Array(k);
  let total = 0;
  let counted = 0;

  for (let i = 0; i < m; i++) {
    const ri = sampleIdx[i] * d;
    const li = labels[sampleIdx[i]];
    if (clusterCount[li] <= 1) continue;
    sums.fill(0);
    for (let j = 0; j < m; j++) {
      if (j === i) continue;
      const rj = sampleIdx[j] * d;
      let acc = 0;
      for (let t = 0; t < d; t++) {
        const diff = x[ri + t] - x[rj + t];
        acc += diff * diff;
      }
      sums[labels[sampleIdx[j]]] += Math.sqrt(acc);
    }
    const a = sums[li] / (clusterCount[li] - 1);
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === li || clusterCount[c] === 0) continue;
      const avg = sums[c] / clusterCount[c];
      if (avg < b) b = avg;
    }
    if (!Number.isFinite(b)) continue;
    const denom = Math.max(a, b);
    if (denom > 0) {
      total += (b - a) / denom;
      counted++;
    }
  }
  return counted > 0 ? total / counted : 0;
}

/** Calinski-Harabasz 指標（大きいほど良い） */
export function calinskiHarabasz(
  x: Float32Array,
  n: number,
  d: number,
  labels: Int32Array,
  centers: Float64Array,
  k: number,
): number {
  if (k < 2 || n <= k) return 0;
  const grand = new Float64Array(d);
  for (let i = 0; i < n; i++) {
    const xi = i * d;
    for (let j = 0; j < d; j++) grand[j] += x[xi + j];
  }
  for (let j = 0; j < d; j++) grand[j] /= n;

  const counts = new Float64Array(k);
  for (let i = 0; i < n; i++) counts[labels[i]]++;

  let between = 0;
  for (let c = 0; c < k; c++) {
    if (counts[c] === 0) continue;
    const base = c * d;
    let acc = 0;
    for (let j = 0; j < d; j++) {
      const diff = centers[base + j] - grand[j];
      acc += diff * diff;
    }
    between += counts[c] * acc;
  }

  let within = 0;
  for (let i = 0; i < n; i++) {
    const xi = i * d;
    const base = labels[i] * d;
    for (let j = 0; j < d; j++) {
      const diff = x[xi + j] - centers[base + j];
      within += diff * diff;
    }
  }
  if (within <= 0) return 0;
  return (between / (k - 1)) / (within / (n - k));
}

/** Davies-Bouldin 指標（小さいほど良い） */
export function daviesBouldin(
  x: Float32Array,
  n: number,
  d: number,
  labels: Int32Array,
  centers: Float64Array,
  k: number,
): number {
  if (k < 2) return 0;
  const counts = new Float64Array(k);
  const spread = new Float64Array(k);
  for (let i = 0; i < n; i++) {
    const c = labels[i];
    counts[c]++;
    const xi = i * d;
    const base = c * d;
    let acc = 0;
    for (let j = 0; j < d; j++) {
      const diff = x[xi + j] - centers[base + j];
      acc += diff * diff;
    }
    spread[c] += Math.sqrt(acc);
  }
  for (let c = 0; c < k; c++) spread[c] = counts[c] > 0 ? spread[c] / counts[c] : 0;

  let total = 0;
  let used = 0;
  for (let a = 0; a < k; a++) {
    if (counts[a] === 0) continue;
    let worst = 0;
    for (let b = 0; b < k; b++) {
      if (a === b || counts[b] === 0) continue;
      let acc = 0;
      for (let j = 0; j < d; j++) {
        const diff = centers[a * d + j] - centers[b * d + j];
        acc += diff * diff;
      }
      const sep = Math.sqrt(acc);
      if (sep <= 0) continue;
      const ratio = (spread[a] + spread[b]) / sep;
      if (ratio > worst) worst = ratio;
    }
    total += worst;
    used++;
  }
  return used > 0 ? total / used : 0;
}
