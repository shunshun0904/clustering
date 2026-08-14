import { buildEncodePlan, rangeIndices } from './encode.ts';
import { fitPca, projectBlock, type PcaModel } from './pca.ts';
import { kmeans } from './kmeans.ts';
import { fitWard, wardAssign, type WardModel } from './ward.ts';
import { calinskiHarabasz, daviesBouldin, silhouetteScore } from './metrics.ts';
import { makeRng, sampleIndices } from './rng.ts';
import {
  axisDrivers,
  buildProfiles,
  findRepresentatives,
  summarizeClusters,
} from './describe.ts';
import type { ClusterResult, Dataset, KScore, RunOptions } from './types.ts';

export type ProgressFn = (phase: string, ratio: number, detail?: string) => void;

const ENCODE_BLOCK = 8192;
const SCATTER_MAX_POINTS = 20000;
const SILHOUETTE_SAMPLE = 1800;
const WARD_SAMPLE = 3000;

/** PCA 学習に使うサンプル行数（次元数に応じてメモリを一定に保つ） */
function pcaSampleSize(n: number, dim: number): number {
  const cap = Math.floor(6_000_000 / Math.max(1, dim));
  return Math.max(1000, Math.min(n, Math.min(20000, cap)));
}

function copyRows(
  src: Float32Array,
  dim: number,
  indices: Int32Array,
  out?: Float32Array,
): Float32Array {
  const dst = out ?? new Float32Array(indices.length * dim);
  for (let i = 0; i < indices.length; i++) {
    const from = indices[i] * dim;
    const to = i * dim;
    for (let j = 0; j < dim; j++) dst[to + j] = src[from + j];
  }
  return dst;
}

/** 特徴量が 1 つも入っていない行を数える */
function countEmptyFeatureRows(dataset: Dataset): number {
  const featureColumns = dataset.columns.filter((c) => c.spec.role === 'feature');
  if (featureColumns.length === 0) return 0;
  let empty = 0;
  const n = dataset.rowCount;
  outer: for (let i = 0; i < n; i++) {
    for (const col of featureColumns) {
      if (col.kind === 'numeric') {
        if (Number.isFinite(col.values[i])) continue outer;
      } else if (col.codes[i] >= 0) continue outer;
    }
    empty++;
  }
  return empty;
}

/**
 * k の自動決定。
 *
 * シルエット係数だけを見ると、実データのように塊が重なっている場合はほぼ必ず
 * k=2 が勝ってしまい、セグメンテーションとして使い物にならない。
 * そこで「シルエット」と「エルボー（慣性の減り方の折れ点）」を正規化して足し合わせる。
 * さらに実務的な制約として、
 *  - 全体の 2% 未満しかない極小クラスタができる k は避ける
 *  - スコアがほぼ同じなら小さい k を選ぶ（解釈しやすさ優先）
 * を入れている。
 */
export function chooseK(scores: KScore[], sizesByK: Map<number, number[]>): number {
  if (scores.length === 0) return 3;
  const usable = scores.filter((s) => {
    const sizes = sizesByK.get(s.k);
    if (!sizes) return true;
    const total = sizes.reduce((a, b) => a + b, 0) || 1;
    return Math.min(...sizes) / total >= 0.02;
  });
  const pool = (usable.length > 0 ? usable : scores).slice().sort((a, b) => a.k - b.k);
  if (pool.length === 1) return pool[0].k;

  const sil = pool.map((s) => (Number.isFinite(s.silhouette) ? s.silhouette : 0));
  const silMin = Math.min(...sil);
  const silMax = Math.max(...sil);
  const silRange = silMax - silMin;

  // エルボー: (k, 慣性) を [0,1]^2 に正規化し、両端を結ぶ弦からの落ち込みが最大の点
  const ks = pool.map((s) => s.k);
  const inertia = pool.map((s) => (Number.isFinite(s.inertia) ? s.inertia : 0));
  const kSpan = ks[ks.length - 1] - ks[0];
  const iMax = Math.max(...inertia);
  const iMin = Math.min(...inertia);
  const iSpan = iMax - iMin;
  const elbow = pool.map((_, i) => {
    if (kSpan <= 0 || iSpan <= 0) return 0;
    const xn = (ks[i] - ks[0]) / kSpan;
    const yn = (inertia[i] - iMin) / iSpan;
    return Math.max(0, 1 - xn - yn);
  });
  const elbowMax = Math.max(...elbow);

  const combined = pool.map((_, i) => {
    const silScore = silRange > 0 ? (sil[i] - silMin) / silRange : 1;
    const elbowScore = elbowMax > 0 ? elbow[i] / elbowMax : 0;
    return 0.55 * silScore + 0.45 * elbowScore;
  });

  const best = Math.max(...combined);
  for (let i = 0; i < pool.length; i++) {
    if (combined[i] >= best - 0.03) return pool[i].k;
  }
  return pool[0].k;
}

export interface PipelineInput {
  dataset: Dataset;
  options: RunOptions;
  onProgress?: ProgressFn;
}

export function runPipeline({ dataset, options, onProgress }: PipelineInput): ClusterResult {
  const started = Date.now();
  const progress = onProgress ?? (() => {});
  const n = dataset.rowCount;

  progress('encode', 0, '特徴量を作成中');
  const plan = buildEncodePlan(dataset);
  const dim = plan.dim;

  // ---- 1. 特徴量行列を作る（必要なら PCA で圧縮） ----
  const usePca = dim > options.pcaThreshold;
  const rdim = usePca ? Math.max(2, Math.min(options.pcaComponents, dim)) : dim;
  const reduced = new Float32Array(n * rdim);

  let pcaModel: PcaModel | null = null;
  let scatterModel: PcaModel | null = null;
  const rng = makeRng(options.seed);

  if (usePca) {
    const sampleSize = pcaSampleSize(n, dim);
    const idx = sampleIndices(n, sampleSize, rng);
    progress('encode', 0.15, `${sampleSize.toLocaleString()} 行で主成分を学習中`);
    const sample = plan.encodeRows(idx);
    pcaModel = fitPca(sample, sampleSize, dim, rdim, options.seed);
    scatterModel = pcaModel;

    progress('reduce', 0.25, `${dim} 次元 → ${rdim} 次元に圧縮中`);
    const block = new Float32Array(ENCODE_BLOCK * dim);
    let indices = rangeIndices(0, ENCODE_BLOCK);
    for (let start = 0; start < n; start += ENCODE_BLOCK) {
      const end = Math.min(n, start + ENCODE_BLOCK);
      indices = rangeIndices(start, end, end - start === ENCODE_BLOCK ? indices : undefined);
      plan.encodeRows(indices, block);
      projectBlock(pcaModel, block, end - start, reduced, start);
      progress('reduce', 0.25 + 0.25 * (end / n));
    }
  } else {
    progress('encode', 0.2, `${dim} 次元の特徴量を作成中`);
    let indices = rangeIndices(0, ENCODE_BLOCK);
    const block = new Float32Array(ENCODE_BLOCK * dim);
    for (let start = 0; start < n; start += ENCODE_BLOCK) {
      const end = Math.min(n, start + ENCODE_BLOCK);
      const count = end - start;
      indices = rangeIndices(start, end, count === ENCODE_BLOCK ? indices : undefined);
      plan.encodeRows(indices, block);
      reduced.set(block.subarray(0, count * dim), start * dim);
      progress('encode', 0.2 + 0.3 * (end / n));
    }
    // 散布図用に 2 成分だけ別途学習する
    const sampleSize = Math.min(n, pcaSampleSize(n, dim));
    const idx = sampleIndices(n, sampleSize, rng);
    const sample = copyRows(reduced, dim, idx);
    scatterModel = fitPca(sample, sampleSize, dim, Math.min(2, dim), options.seed);
  }

  // ---- 2. k の探索 ----
  progress('search-k', 0.55, 'クラスタ数を評価中');
  const searchSize = Math.min(n, options.autoKSampleSize);
  const searchIdx = sampleIndices(n, searchSize, makeRng(options.seed + 1));
  const searchX = searchSize === n ? reduced : copyRows(reduced, rdim, searchIdx);
  const silhouetteIdx = sampleIndices(
    searchSize,
    Math.min(searchSize, SILHOUETTE_SAMPLE),
    makeRng(options.seed + 2),
  );

  let searchWard: WardModel | null = null;
  if (options.algorithm === 'ward') {
    const wardSize = Math.min(searchSize, WARD_SAMPLE);
    const wardIdx = sampleIndices(searchSize, wardSize, makeRng(options.seed + 3));
    searchWard = fitWard(copyRows(searchX, rdim, wardIdx), wardSize, rdim, wardIdx);
  }

  const kMin = Math.max(2, Math.min(options.kMin, options.kMax));
  const kMax = Math.max(kMin, Math.min(options.kMax, Math.max(2, Math.floor(searchSize / 5))));
  const kScores: KScore[] = [];
  const sizesByK = new Map<number, number[]>();

  const kList: number[] = [];
  if (options.k !== null) {
    // 指定されていても、比較のためにレンジ全体は評価する
    for (let k = kMin; k <= kMax; k++) kList.push(k);
    if (!kList.includes(options.k)) kList.push(options.k);
    kList.sort((a, b) => a - b);
  } else {
    for (let k = kMin; k <= kMax; k++) kList.push(k);
  }

  for (let i = 0; i < kList.length; i++) {
    const k = kList[i];
    const fit =
      options.algorithm === 'ward' && searchWard
        ? wardAssign(searchWard, searchX, searchSize, rdim, k)
        : kmeans(searchX, searchSize, rdim, k, { seed: options.seed, restarts: 1, maxIter: 30 });
    const sizes = new Array<number>(k).fill(0);
    for (let r = 0; r < searchSize; r++) sizes[fit.labels[r]]++;
    sizesByK.set(k, sizes);
    kScores.push({
      k,
      inertia: fit.inertia / Math.max(1, searchSize),
      silhouette: silhouetteScore(searchX, rdim, fit.labels, silhouetteIdx, k),
      calinskiHarabasz: calinskiHarabasz(searchX, searchSize, rdim, fit.labels, fit.centers, k),
      daviesBouldin: daviesBouldin(searchX, searchSize, rdim, fit.labels, fit.centers, k),
    });
    progress('search-k', 0.55 + 0.2 * ((i + 1) / kList.length), `k=${k} を評価`);
  }

  const chosenAutomatically = options.k === null;
  const k = chosenAutomatically ? chooseK(kScores, sizesByK) : options.k!;

  // ---- 3. 全件でクラスタリング ----
  progress('cluster', 0.78, `k=${k} で全 ${n.toLocaleString()} 行を分類中`);
  let labels: Int32Array;
  let centers: Float64Array;
  if (options.algorithm === 'ward') {
    const wardSize = Math.min(n, WARD_SAMPLE);
    const wardIdx = sampleIndices(n, wardSize, makeRng(options.seed + 5));
    const model = fitWard(copyRows(reduced, rdim, wardIdx), wardSize, rdim, wardIdx);
    const fit = wardAssign(model, reduced, n, rdim, k);
    labels = fit.labels;
    centers = fit.centers;
  } else {
    const fit = kmeans(reduced, n, rdim, k, { seed: options.seed, maxIter: 60 });
    labels = fit.labels;
    centers = fit.centers;
  }

  const actualK = Math.max(1, new Set(Array.from(labels.slice(0, Math.min(n, 100000)))).size);
  const effectiveK = Math.max(actualK, k);

  // ---- 4. プロファイリング ----
  progress('profile', 0.88, 'クラスタの特徴を抽出中');
  const sizes = new Array<number>(effectiveK).fill(0);
  for (let i = 0; i < n; i++) sizes[labels[i]]++;
  const profiles = buildProfiles(dataset, labels, effectiveK, sizes);
  const representatives = findRepresentatives(reduced, n, rdim, labels, centers, effectiveK);
  const summary = summarizeClusters(profiles, labels, effectiveK, representatives);

  // ---- 5. 散布図用の 2 次元座標 ----
  progress('profile', 0.95, '散布図を準備中');
  const scatterCount = Math.min(n, SCATTER_MAX_POINTS);
  const scatterIdx = sampleIndices(n, scatterCount, makeRng(options.seed + 7));
  const sx = new Float32Array(scatterCount);
  const sy = new Float32Array(scatterCount);
  const slabel = new Int32Array(scatterCount);

  if (usePca) {
    for (let i = 0; i < scatterCount; i++) {
      const base = scatterIdx[i] * rdim;
      sx[i] = reduced[base];
      sy[i] = rdim > 1 ? reduced[base + 1] : 0;
      slabel[i] = labels[scatterIdx[i]];
    }
  } else if (scatterModel) {
    const sub = copyRows(reduced, rdim, scatterIdx);
    const proj = new Float32Array(scatterCount * scatterModel.k);
    projectBlock(scatterModel, sub, scatterCount, proj, 0);
    for (let i = 0; i < scatterCount; i++) {
      sx[i] = proj[i * scatterModel.k];
      sy[i] = scatterModel.k > 1 ? proj[i * scatterModel.k + 1] : 0;
      slabel[i] = labels[scatterIdx[i]];
    }
  }

  const featureLabels = plan.features.map((f) => f.column);
  const drivers: [string[], string[]] = scatterModel
    ? [
        axisDrivers(scatterModel.components, scatterModel.d, featureLabels, 0),
        scatterModel.k > 1
          ? axisDrivers(scatterModel.components, scatterModel.d, featureLabels, 1)
          : [],
      ]
    : [[], []];

  const explained: [number, number] = scatterModel
    ? [scatterModel.explainedRatio[0] ?? 0, scatterModel.explainedRatio[1] ?? 0]
    : [0, 0];

  const overallSilhouette = silhouetteScore(
    searchX,
    rdim,
    searchSize === n ? labels : (() => {
      const sub = new Int32Array(searchSize);
      for (let i = 0; i < searchSize; i++) sub[i] = labels[searchIdx[i]];
      return sub;
    })(),
    silhouetteIdx,
    effectiveK,
  );

  const emptyRows = countEmptyFeatureRows(dataset);

  progress('done', 1);

  return {
    k: effectiveK,
    labels,
    sizes: summary.sizes,
    clusters: summary.clusters,
    profiles,
    kScores,
    chosenAutomatically,
    scatter: {
      x: sx,
      y: sy,
      label: slabel,
      rowIndex: scatterIdx,
      explained,
      axisDrivers: drivers,
    },
    featureCount: dim,
    usedColumns: plan.usedColumns,
    reducedDim: rdim,
    silhouette: overallSilhouette,
    elapsedMs: Date.now() - started,
    effectiveRows: n - emptyRows,
  };
}
