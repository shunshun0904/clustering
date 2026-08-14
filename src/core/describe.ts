import type {
  CategoricalProfile,
  ClusterSummary,
  ColumnProfile,
  Dataset,
  Highlight,
  NumericProfile,
} from './types.ts';
import { formatByKind, formatPercent, formatRatio } from './format.ts';
import { quantileSorted } from './stats.ts';

/**
 * クラスタの解釈（プロファイリング）。
 * マーケティングで実際に使うのはここの出力なので、
 *  - 効果量（全体平均からの標準化差分 z）
 *  - 倍率（全体平均比 / リフト）
 *  - 列ごとの分離度（eta^2 / Cramer's V）
 * を必ず出す。
 */

const MEDIAN_SAMPLE_PER_CLUSTER = 5000;
const MAX_LEVELS_IN_PROFILE = 12;

function numericProfile(
  column: Extract<Dataset['columns'][number], { kind: 'numeric' }>,
  labels: Int32Array,
  k: number,
  sizes: number[],
): NumericProfile {
  const values = column.values;
  const n = values.length;
  const counts = new Float64Array(k);
  const sums = new Float64Array(k);

  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const c = labels[i];
    counts[c]++;
    sums[c] += v;
  }

  // 中央値はクラスタごとに間引きサンプルを取ってから求める
  const buckets: number[][] = Array.from({ length: k }, () => []);
  const strides = new Int32Array(k);
  for (let c = 0; c < k; c++) {
    strides[c] = Math.max(1, Math.ceil((sizes[c] || 1) / MEDIAN_SAMPLE_PER_CLUSTER));
  }
  const seen = new Int32Array(k);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const c = labels[i];
    if (seen[c] % strides[c] === 0) buckets[c].push(v);
    seen[c]++;
  }

  const overallMean = column.stats.mean;
  const overallSd = column.stats.sd || 1;
  const overallMedian = column.stats.median;

  // eta^2 = 群間平方和 / 全平方和
  let between = 0;
  let totalCount = 0;
  for (let c = 0; c < k; c++) {
    if (counts[c] === 0) continue;
    const mean = sums[c] / counts[c];
    between += counts[c] * (mean - overallMean) * (mean - overallMean);
    totalCount += counts[c];
  }
  const totalSs = overallSd * overallSd * Math.max(1, totalCount - 1);
  const separation = totalSs > 0 ? Math.min(1, between / totalSs) : 0;

  const clusters = [] as NumericProfile['clusters'];
  for (let c = 0; c < k; c++) {
    const mean = counts[c] > 0 ? sums[c] / counts[c] : NaN;
    buckets[c].sort((a, b) => a - b);
    const median = buckets[c].length > 0 ? quantileSorted(buckets[c], 0.5) : NaN;
    const z = Number.isFinite(mean) ? (mean - overallMean) / overallSd : 0;
    const ratio =
      Number.isFinite(mean) && Math.abs(overallMean) > 1e-12 ? mean / overallMean : NaN;
    clusters.push({ mean, median, z, ratio });
  }

  return {
    column: column.spec.name,
    kind: 'numeric',
    valueKind: column.spec.kind,
    overallMean,
    overallMedian,
    clusters,
    separation,
  };
}

function categoricalProfile(
  column: Extract<Dataset['columns'][number], { kind: 'categorical' }>,
  labels: Int32Array,
  k: number,
): CategoricalProfile {
  const top = column.stats.levels.slice(0, MAX_LEVELS_IN_PROFILE);
  const dictIndex = new Map<string, number>();
  for (let i = 0; i < column.dictionary.length; i++) dictIndex.set(column.dictionary[i], i);

  const codeToSlot = new Int32Array(column.dictionary.length).fill(-1);
  const levels: string[] = [];
  for (const level of top) {
    const code = dictIndex.get(level.value);
    if (code === undefined) continue;
    codeToSlot[code] = levels.length;
    levels.push(level.value);
  }
  const otherSlot = levels.length;
  const hasOther = column.stats.distinct > levels.length;
  if (hasOther) levels.push('その他');

  const slotCount = levels.length;
  const table = new Float64Array(k * slotCount);
  const rowTotals = new Float64Array(k);
  const colTotals = new Float64Array(slotCount);
  let grand = 0;

  const codes = column.codes;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code < 0) continue;
    let slot = codeToSlot[code];
    if (slot < 0) {
      if (!hasOther) continue;
      slot = otherSlot;
    }
    const c = labels[i];
    table[c * slotCount + slot]++;
    rowTotals[c]++;
    colTotals[slot]++;
    grand++;
  }

  const overallShare = new Array<number>(slotCount);
  for (let s = 0; s < slotCount; s++) overallShare[s] = grand > 0 ? colTotals[s] / grand : 0;

  const clusters = [] as CategoricalProfile['clusters'];
  for (let c = 0; c < k; c++) {
    const share = new Array<number>(slotCount);
    const lift = new Array<number>(slotCount);
    for (let s = 0; s < slotCount; s++) {
      share[s] = rowTotals[c] > 0 ? table[c * slotCount + s] / rowTotals[c] : 0;
      lift[s] = overallShare[s] > 0 ? share[s] / overallShare[s] : 0;
    }
    clusters.push({ share, lift });
  }

  // Cramer's V
  let chi2 = 0;
  if (grand > 0) {
    for (let c = 0; c < k; c++) {
      for (let s = 0; s < slotCount; s++) {
        const expected = (rowTotals[c] * colTotals[s]) / grand;
        if (expected <= 0) continue;
        const diff = table[c * slotCount + s] - expected;
        chi2 += (diff * diff) / expected;
      }
    }
  }
  const minDim = Math.max(1, Math.min(k, slotCount) - 1);
  const separation = grand > 0 ? Math.min(1, Math.sqrt(chi2 / (grand * minDim))) : 0;

  return {
    column: column.spec.name,
    kind: 'categorical',
    levels,
    overallShare,
    clusters,
    separation,
  };
}

/** 全列のプロファイルを作る */
export function buildProfiles(
  dataset: Dataset,
  labels: Int32Array,
  k: number,
  sizes: number[],
): ColumnProfile[] {
  const profiles: ColumnProfile[] = [];
  for (const column of dataset.columns) {
    if (column.spec.role === 'ignore') continue;
    if (column.kind === 'numeric') {
      if (column.stats.count === 0) continue;
      profiles.push(numericProfile(column, labels, k, sizes));
    } else {
      if (column.stats.distinct <= 1) continue;
      profiles.push(categoricalProfile(column, labels, k));
    }
  }
  return profiles;
}

const Z_THRESHOLD = 0.2;
const LIFT_THRESHOLD = 1.25;
const MIN_SHARE_FOR_HIGHLIGHT = 0.08;

/** 1 クラスタの「特徴」を強い順に抽出する */
export function buildHighlights(
  profiles: ColumnProfile[],
  cluster: number,
  limit = 6,
): Highlight[] {
  const out: Highlight[] = [];
  for (const profile of profiles) {
    if (profile.kind === 'numeric') {
      const entry = profile.clusters[cluster];
      if (!entry || !Number.isFinite(entry.mean)) continue;
      const z = entry.z;
      if (Math.abs(z) < Z_THRESHOLD) continue;
      const kind = profile.valueKind;
      const meanText = formatByKind(kind, entry.mean);
      const ratioText =
        Number.isFinite(entry.ratio) && entry.ratio > 0 && kind !== 'datetime'
          ? `全体の${formatRatio(entry.ratio)}`
          : `全体${formatByKind(kind, profile.overallMean)}`;
      out.push({
        column: profile.column,
        text: `${profile.column} ${meanText}（${ratioText}）`,
        strength: Math.abs(z) * (0.5 + profile.separation),
        direction: z > 0 ? 'high' : 'low',
        value: meanText,
      });
    } else {
      let bestSlot = -1;
      let bestScore = 0;
      for (let s = 0; s < profile.levels.length; s++) {
        const share = profile.clusters[cluster]?.share[s] ?? 0;
        const lift = profile.clusters[cluster]?.lift[s] ?? 0;
        if (share < MIN_SHARE_FOR_HIGHLIGHT) continue;
        if (lift < LIFT_THRESHOLD) continue;
        const score = share * Math.log(lift);
        if (score > bestScore) {
          bestScore = score;
          bestSlot = s;
        }
      }
      if (bestSlot < 0) continue;
      const share = profile.clusters[cluster].share[bestSlot];
      const lift = profile.clusters[cluster].lift[bestSlot];
      out.push({
        column: profile.column,
        text: `${profile.column} は「${profile.levels[bestSlot]}」が ${formatPercent(share)}（全体の${formatRatio(lift)}）`,
        strength: bestScore * 3 * (0.5 + profile.separation),
        direction: 'category',
        value: profile.levels[bestSlot],
      });
    }
  }
  out.sort((a, b) => b.strength - a.strength);
  return out.slice(0, limit);
}

/** 特徴からクラスタ名を自動生成する */
export function autoName(highlights: Highlight[], index: number): string {
  const parts: string[] = [];
  for (const h of highlights) {
    if (parts.length >= 2) break;
    if (h.direction === 'high') parts.push(`高${h.column}`);
    else if (h.direction === 'low') parts.push(`低${h.column}`);
    else parts.push(`${h.value}`);
  }
  if (parts.length === 0) return `セグメント${index + 1}`;
  return parts.join('×') + '層';
}

/** クラスタ中心に最も近い代表行を探す */
export function findRepresentatives(
  reduced: Float32Array,
  n: number,
  d: number,
  labels: Int32Array,
  centers: Float64Array,
  k: number,
  perCluster = 3,
): number[][] {
  const best: { idx: number; dist: number }[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) {
    const c = labels[i];
    const base = c * d;
    const xi = i * d;
    let acc = 0;
    for (let j = 0; j < d; j++) {
      const diff = reduced[xi + j] - centers[base + j];
      acc += diff * diff;
    }
    const list = best[c];
    if (list.length < perCluster) {
      list.push({ idx: i, dist: acc });
      list.sort((a, b) => a.dist - b.dist);
    } else if (acc < list[list.length - 1].dist) {
      list[list.length - 1] = { idx: i, dist: acc };
      list.sort((a, b) => a.dist - b.dist);
    }
  }
  return best.map((list) => list.map((e) => e.idx));
}

/** クラスタ要約をまとめる */
export function summarizeClusters(
  profiles: ColumnProfile[],
  labels: Int32Array,
  k: number,
  representatives: number[][],
): { clusters: ClusterSummary[]; sizes: number[] } {
  const sizes = new Array<number>(k).fill(0);
  for (let i = 0; i < labels.length; i++) sizes[labels[i]]++;
  const total = labels.length || 1;

  const clusters: ClusterSummary[] = [];
  const usedNames = new Map<string, number>();
  for (let c = 0; c < k; c++) {
    const highlights = buildHighlights(profiles, c);
    let name = autoName(highlights, c);
    const dup = usedNames.get(name);
    if (dup !== undefined) {
      usedNames.set(name, dup + 1);
      name = `${name}${dup + 1}`;
    } else {
      usedNames.set(name, 1);
    }
    clusters.push({
      id: c,
      size: sizes[c],
      share: sizes[c] / total,
      name,
      highlights,
      representativeRows: representatives[c] ?? [],
    });
  }
  return { clusters, sizes };
}

/** 主成分軸に効いている列名（散布図の軸ラベル用） */
export function axisDrivers(
  components: Float64Array,
  d: number,
  featureLabels: string[],
  axis: number,
  top = 3,
): string[] {
  const base = axis * d;
  const idx = Array.from({ length: d }, (_, i) => i);
  idx.sort((a, b) => Math.abs(components[base + b]) - Math.abs(components[base + a]));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of idx) {
    const label = featureLabels[i];
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(`${components[base + i] >= 0 ? '+' : '−'}${label}`);
    if (out.length >= top) break;
  }
  return out;
}
