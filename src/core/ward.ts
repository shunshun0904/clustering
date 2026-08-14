import { assign } from './kmeans.ts';

/**
 * Ward 法（階層クラスタリング）。
 * サンプル（既定 3000 点）で樹形図を作り、任意の k で切ってから
 * 得られた重心に全点を割り当てる。k-means より「入れ子になった層」を
 * 見つけやすく、球状でないセグメントに強い。
 *
 * アルゴリズムは nearest-neighbor chain（O(m^2)）。
 * 距離行列には Ward 距離の二乗 M(I,J) = 2 * ΔSSE を保持する。
 */

export interface WardTree {
  /** マージ順。2*(m-1) 要素で [a0,b0, a1,b1, ...] */
  merges: Int32Array;
  m: number;
}

export function buildWardTree(x: Float32Array, m: number, d: number): WardTree {
  const size = m * m;
  const dist = new Float32Array(size);
  for (let i = 0; i < m; i++) {
    const xi = i * d;
    for (let j = i + 1; j < m; j++) {
      const xj = j * d;
      let sum = 0;
      for (let t = 0; t < d; t++) {
        const diff = x[xi + t] - x[xj + t];
        sum += diff * diff;
      }
      dist[i * m + j] = sum;
      dist[j * m + i] = sum;
    }
  }

  const active = new Uint8Array(m).fill(1);
  const counts = new Int32Array(m).fill(1);
  const merges = new Int32Array(2 * (m - 1));
  const chain = new Int32Array(m + 2);
  let chainLen = 0;
  let remaining = m;
  let mergeIdx = 0;

  const nearest = (a: number, exclude: number): { idx: number; dist: number } => {
    let bestIdx = -1;
    let bestDist = Infinity;
    const row = a * m;
    for (let b = 0; b < m; b++) {
      if (b === a || !active[b]) continue;
      const dv = dist[row + b];
      if (dv < bestDist || (dv === bestDist && b === exclude)) {
        bestDist = dv;
        bestIdx = b;
      }
    }
    return { idx: bestIdx, dist: bestDist };
  };

  while (remaining > 1) {
    if (chainLen === 0) {
      let start = -1;
      for (let i = 0; i < m; i++) {
        if (active[i]) {
          start = i;
          break;
        }
      }
      chain[chainLen++] = start;
    }

    for (;;) {
      const a = chain[chainLen - 1];
      const prev = chainLen >= 2 ? chain[chainLen - 2] : -1;
      const { idx: b } = nearest(a, prev);
      if (b < 0) {
        chainLen = 0;
        break;
      }
      if (chainLen >= 2 && b === prev) break;
      chain[chainLen++] = b;
    }
    if (chainLen < 2) continue;

    const b = chain[--chainLen];
    const a = chain[--chainLen];
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);

    merges[mergeIdx * 2] = lo;
    merges[mergeIdx * 2 + 1] = hi;
    mergeIdx++;

    // Lance-Williams（Ward）で lo を統合先として距離を更新する
    const nA = counts[lo];
    const nB = counts[hi];
    const dAB = dist[lo * m + hi];
    for (let kk = 0; kk < m; kk++) {
      if (!active[kk] || kk === lo || kk === hi) continue;
      const nK = counts[kk];
      const dAK = dist[lo * m + kk];
      const dBK = dist[hi * m + kk];
      const updated = ((nA + nK) * dAK + (nB + nK) * dBK - nK * dAB) / (nA + nB + nK);
      dist[lo * m + kk] = updated;
      dist[kk * m + lo] = updated;
    }
    counts[lo] = nA + nB;
    active[hi] = 0;
    remaining--;
  }

  return { merges, m };
}

/** マージ順を (m - k) 回まで再生して、サンプル点のラベルを得る */
export function labelsFromTree(tree: WardTree, k: number): Int32Array {
  const { merges, m } = tree;
  const parent = new Int32Array(m);
  for (let i = 0; i < m; i++) parent[i] = i;
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== root) {
      const next = parent[i];
      parent[i] = root;
      i = next;
    }
    return root;
  };

  const steps = Math.max(0, m - k);
  for (let s = 0; s < steps && s < m - 1; s++) {
    const a = find(merges[s * 2]);
    const b = find(merges[s * 2 + 1]);
    if (a !== b) parent[b] = a;
  }

  const remap = new Map<number, number>();
  const labels = new Int32Array(m);
  for (let i = 0; i < m; i++) {
    const root = find(i);
    let id = remap.get(root);
    if (id === undefined) {
      id = remap.size;
      remap.set(root, id);
    }
    labels[i] = id;
  }
  return labels;
}

/** サンプルのラベルから重心を計算する */
export function centroidsFromLabels(
  x: Float32Array,
  m: number,
  d: number,
  labels: Int32Array,
  k: number,
): Float64Array {
  const centers = new Float64Array(k * d);
  const counts = new Float64Array(k);
  for (let i = 0; i < m; i++) {
    const c = labels[i];
    if (c < 0 || c >= k) continue;
    counts[c]++;
    const base = c * d;
    const xi = i * d;
    for (let j = 0; j < d; j++) centers[base + j] += x[xi + j];
  }
  for (let c = 0; c < k; c++) {
    const cnt = counts[c] || 1;
    const base = c * d;
    for (let j = 0; j < d; j++) centers[base + j] /= cnt;
  }
  return centers;
}

export interface WardModel {
  tree: WardTree;
  sample: Float32Array;
  sampleSize: number;
  sampleIndex: Int32Array;
}

/** サンプル行列から Ward の樹形図を作る（k を変えても再利用できる） */
export function fitWard(
  sample: Float32Array,
  sampleSize: number,
  d: number,
  sampleIndex: Int32Array,
): WardModel {
  return {
    tree: buildWardTree(sample, sampleSize, d),
    sample,
    sampleSize,
    sampleIndex,
  };
}

/** 指定の k で切って、全点に割り当てる */
export function wardAssign(
  model: WardModel,
  x: Float32Array,
  n: number,
  d: number,
  k: number,
): { centers: Float64Array; labels: Int32Array; inertia: number } {
  const sampleLabels = labelsFromTree(model.tree, k);
  let actualK = 0;
  for (let i = 0; i < sampleLabels.length; i++) {
    if (sampleLabels[i] + 1 > actualK) actualK = sampleLabels[i] + 1;
  }
  const centers = centroidsFromLabels(model.sample, model.sampleSize, d, sampleLabels, actualK);
  const labels = new Int32Array(n);
  const inertia = assign(x, n, d, centers, actualK, labels);
  return { centers, labels, inertia };
}
