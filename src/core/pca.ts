import { makeGaussian, makeRng } from './rng.ts';

/**
 * ランダム化 SVD による PCA。
 * 数百次元 × 数万行のサンプルから主成分を求め、全行はブロックごとに射影する。
 * 共分散行列（d×d）を作らないので、d が大きくてもメモリが破綻しない。
 */

export interface PcaModel {
  /** 各特徴量の平均（d） */
  mean: Float64Array;
  /** 主成分（k × d, 行ごとに 1 成分） */
  components: Float64Array;
  /** 各成分の分散 */
  variances: Float64Array;
  /** 寄与率 */
  explainedRatio: Float64Array;
  k: number;
  d: number;
}

/** 行優先の n×l 行列を列ごとに正規直交化（modified Gram-Schmidt） */
function orthonormalize(mat: Float64Array, n: number, l: number): void {
  for (let j = 0; j < l; j++) {
    // 既存の列と直交化
    for (let p = 0; p < j; p++) {
      let dot = 0;
      for (let i = 0; i < n; i++) dot += mat[i * l + j] * mat[i * l + p];
      if (dot === 0) continue;
      for (let i = 0; i < n; i++) mat[i * l + j] -= dot * mat[i * l + p];
    }
    let norm = 0;
    for (let i = 0; i < n; i++) norm += mat[i * l + j] * mat[i * l + j];
    norm = Math.sqrt(norm);
    if (norm < 1e-10) {
      // 退化した方向は 0 埋め（後段で分散 0 の成分として落ちる）
      for (let i = 0; i < n; i++) mat[i * l + j] = 0;
      continue;
    }
    const inv = 1 / norm;
    for (let i = 0; i < n; i++) mat[i * l + j] *= inv;
  }
}

/** Y = A * Z ; A: n×d(行優先, Float32), Z: d×l, Y: n×l */
function multiplyAZ(
  a: Float32Array,
  n: number,
  d: number,
  z: Float64Array,
  l: number,
  out: Float64Array,
  mean: Float64Array,
): void {
  out.fill(0);
  for (let i = 0; i < n; i++) {
    const aRow = i * d;
    const oRow = i * l;
    for (let k = 0; k < d; k++) {
      const v = a[aRow + k] - mean[k];
      if (v === 0) continue;
      const zRow = k * l;
      for (let j = 0; j < l; j++) out[oRow + j] += v * z[zRow + j];
    }
  }
}

/** Z = A^T * Y ; A: n×d, Y: n×l, Z: d×l */
function multiplyAtY(
  a: Float32Array,
  n: number,
  d: number,
  y: Float64Array,
  l: number,
  out: Float64Array,
  mean: Float64Array,
): void {
  out.fill(0);
  for (let i = 0; i < n; i++) {
    const aRow = i * d;
    const yRow = i * l;
    for (let k = 0; k < d; k++) {
      const v = a[aRow + k] - mean[k];
      if (v === 0) continue;
      const zRow = k * l;
      for (let j = 0; j < l; j++) out[zRow + j] += v * y[yRow + j];
    }
  }
}

/** 対称行列の固有分解（Jacobi 法）。l は 100 程度までを想定。 */
export function jacobiEigen(
  input: Float64Array,
  l: number,
  maxSweeps = 60,
): { values: Float64Array; vectors: Float64Array } {
  const a = input.slice();
  const v = new Float64Array(l * l);
  for (let i = 0; i < l; i++) v[i * l + i] = 1;

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < l; p++) {
      for (let q = p + 1; q < l; q++) off += a[p * l + q] * a[p * l + q];
    }
    if (off < 1e-18) break;

    for (let p = 0; p < l; p++) {
      for (let q = p + 1; q < l; q++) {
        const apq = a[p * l + q];
        if (Math.abs(apq) < 1e-15) continue;
        const app = a[p * l + p];
        const aqq = a[q * l + q];
        const theta = (aqq - app) / (2 * apq);
        const t =
          Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let i = 0; i < l; i++) {
          const aip = a[i * l + p];
          const aiq = a[i * l + q];
          a[i * l + p] = c * aip - s * aiq;
          a[i * l + q] = s * aip + c * aiq;
        }
        for (let i = 0; i < l; i++) {
          const api = a[p * l + i];
          const aqi = a[q * l + i];
          a[p * l + i] = c * api - s * aqi;
          a[q * l + i] = s * api + c * aqi;
        }
        for (let i = 0; i < l; i++) {
          const vip = v[i * l + p];
          const viq = v[i * l + q];
          v[i * l + p] = c * vip - s * viq;
          v[i * l + q] = s * vip + c * viq;
        }
      }
    }
  }

  const values = new Float64Array(l);
  for (let i = 0; i < l; i++) values[i] = a[i * l + i];
  return { values, vectors: v };
}

/**
 * サンプル行列（n×d, 行優先）から上位 k 主成分を求める。
 */
export function fitPca(
  sample: Float32Array,
  n: number,
  d: number,
  k: number,
  seed = 42,
  powerIterations = 1,
): PcaModel {
  const kk = Math.max(1, Math.min(k, Math.min(n - 1, d)));
  const l = Math.min(d, Math.min(n, kk + 8));

  const mean = new Float64Array(d);
  for (let i = 0; i < n; i++) {
    const row = i * d;
    for (let j = 0; j < d; j++) mean[j] += sample[row + j];
  }
  for (let j = 0; j < d; j++) mean[j] /= n;

  // 全体分散（寄与率の分母）
  let totalVar = 0;
  for (let i = 0; i < n; i++) {
    const row = i * d;
    for (let j = 0; j < d; j++) {
      const v = sample[row + j] - mean[j];
      totalVar += v * v;
    }
  }
  totalVar /= Math.max(1, n - 1);

  const rng = makeRng(seed);
  const gauss = makeGaussian(rng);
  let z = new Float64Array(d * l);
  for (let i = 0; i < d * l; i++) z[i] = gauss();

  const y = new Float64Array(n * l);
  multiplyAZ(sample, n, d, z, l, y, mean);
  orthonormalize(y, n, l);

  for (let it = 0; it < powerIterations; it++) {
    multiplyAtY(sample, n, d, y, l, z, mean);
    orthonormalize(z, d, l);
    multiplyAZ(sample, n, d, z, l, y, mean);
    orthonormalize(y, n, l);
  }

  // B = Y^T A  (l×d) を Z (d×l) として計算し、C = B B^T = Z^T Z (l×l)
  multiplyAtY(sample, n, d, y, l, z, mean);
  const c = new Float64Array(l * l);
  for (let p = 0; p < l; p++) {
    for (let q = p; q < l; q++) {
      let sum = 0;
      for (let i = 0; i < d; i++) sum += z[i * l + p] * z[i * l + q];
      c[p * l + q] = sum;
      c[q * l + p] = sum;
    }
  }

  const { values, vectors } = jacobiEigen(c, l);
  const order = Array.from({ length: l }, (_, i) => i).sort((a, b) => values[b] - values[a]);

  const kFinal = Math.min(kk, l);
  const components = new Float64Array(kFinal * d);
  const variances = new Float64Array(kFinal);
  const explainedRatio = new Float64Array(kFinal);

  for (let ci = 0; ci < kFinal; ci++) {
    const src = order[ci];
    const sigma = Math.sqrt(Math.max(values[src], 0));
    // v = Z * u / sigma  （Z は d×l, u は l 次元）
    const compRow = ci * d;
    if (sigma < 1e-12) {
      variances[ci] = 0;
      explainedRatio[ci] = 0;
      continue;
    }
    let norm = 0;
    for (let i = 0; i < d; i++) {
      let sum = 0;
      const zRow = i * l;
      for (let j = 0; j < l; j++) sum += z[zRow + j] * vectors[j * l + src];
      const val = sum / sigma;
      components[compRow + i] = val;
      norm += val * val;
    }
    norm = Math.sqrt(norm);
    if (norm > 1e-12) {
      const inv = 1 / norm;
      for (let i = 0; i < d; i++) components[compRow + i] *= inv;
    }
    variances[ci] = values[src] / Math.max(1, n - 1);
    explainedRatio[ci] = totalVar > 0 ? variances[ci] / totalVar : 0;
  }

  return { mean, components, variances, explainedRatio, k: kFinal, d };
}

/** ブロック（rows×d, 行優先）を主成分空間に射影する */
export function projectBlock(
  model: PcaModel,
  block: Float32Array,
  rows: number,
  out: Float32Array,
  outOffsetRows: number,
): void {
  const { d, k, mean, components } = model;
  for (let i = 0; i < rows; i++) {
    const src = i * d;
    const dst = (outOffsetRows + i) * k;
    for (let c = 0; c < k; c++) {
      const compRow = c * d;
      let sum = 0;
      for (let j = 0; j < d; j++) sum += (block[src + j] - mean[j]) * components[compRow + j];
      out[dst + c] = sum;
    }
  }
}
