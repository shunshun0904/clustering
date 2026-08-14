import type { ColumnData, Dataset, FeatureMeta, NumericTransform } from './types.ts';
import { lowerBound, probit, quantileSorted } from './stats.ts';

/**
 * 列 → 数値特徴量への変換。
 *
 * 設計方針:
 *  - 1 つの元列が特徴量空間に与える分散の合計を 1 に揃える。
 *    こうしないと、水準の多いカテゴリ列（ワンホットで 30 次元）が
 *    数値列 1 本を圧倒してしまい、距離が意味を失う。
 *  - 派生次元数 m に対して 1/sqrt(m) を掛けることで合計分散を 1 にする。
 *  - ユーザー指定の weight を最後に掛ける。
 */

const MAX_ONEHOT_LEVELS = 30;
const MISSING_INDICATOR_MIN_RATE = 0.02;
const MISSING_INDICATOR_MAX_RATE = 0.7;

interface ColumnEncoder {
  dims: number;
  meta: FeatureMeta[];
  /** out は行優先 (rows.length x totalDim)。offset 列目から dims 本を埋める */
  writeBlock(rows: Int32Array, out: Float32Array, totalDim: number, offset: number): void;
}

export interface EncodePlan {
  dim: number;
  features: FeatureMeta[];
  encoders: ColumnEncoder[];
  usedColumns: string[];
  /** ブロック単位でエンコードする */
  encodeRows(rows: Int32Array, out?: Float32Array): Float32Array;
}

function chooseTransform(
  transform: NumericTransform,
  column: Extract<ColumnData, { kind: 'numeric' }>,
): Exclude<NumericTransform, 'auto'> {
  if (transform !== 'auto') return transform;
  const s = column.stats;
  if (column.spec.kind === 'datetime') return 'standard';
  if (column.spec.kind === 'boolean') return 'standard';
  if (s.count === 0 || s.sd === 0) return 'standard';
  const iqr = s.p75 - s.p25;
  const spread = s.p99 - s.p01;
  // 裾が極端に重い（外れ値が支配的）
  const heavyTail = spread > 0 && (s.max - s.min) / spread > 20;
  if (Math.abs(s.skewness) > 8 || heavyTail) return 'quantile';
  if (s.skewness > 1.2 && s.min >= 0) return 'log';
  if (iqr > 0 && spread / iqr > 12) return 'robust';
  return 'standard';
}

/** 分位点変換用に、値のソート済みサンプルを作る */
function sortedSample(values: Float64Array, cap = 20000): Float64Array {
  let count = 0;
  for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) count++;
  if (count === 0) return new Float64Array(0);
  const stride = count > cap ? Math.ceil(count / cap) : 1;
  const out = new Float64Array(Math.ceil(count / stride));
  let seen = 0;
  let w = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (seen % stride === 0 && w < out.length) out[w++] = v;
    seen++;
  }
  const trimmed = w === out.length ? out : out.slice(0, w);
  trimmed.sort();
  return trimmed;
}

function makeNumericEncoder(
  column: Extract<ColumnData, { kind: 'numeric' }>,
  rowCount: number,
): ColumnEncoder {
  const values = column.values;
  const stats = column.stats;
  const spec = column.spec;
  const mode = chooseTransform(spec.transform, column);
  const missingRate = rowCount > 0 ? stats.missing / rowCount : 0;
  const withIndicator =
    missingRate >= MISSING_INDICATOR_MIN_RATE && missingRate <= MISSING_INDICATOR_MAX_RATE;

  // 変換関数
  let map: (x: number) => number;
  let sample: Float64Array | null = null;
  switch (mode) {
    case 'log':
      map = (x) => Math.log1p(Math.max(0, x));
      break;
    case 'quantile':
      sample = sortedSample(values);
      map = (x) => {
        if (sample!.length === 0) return 0;
        const rank = lowerBound(sample!, x);
        const p = (rank + 0.5) / sample!.length;
        return probit(Math.min(0.9995, Math.max(0.0005, p)));
      };
      break;
    default:
      map = (x) => x;
      break;
  }

  // 変換後のセンター・スケールを求める
  let center = 0;
  let scale = 1;
  if (mode === 'robust') {
    center = stats.median;
    const iqr = stats.p75 - stats.p25;
    scale = iqr > 0 ? iqr / 1.349 : stats.sd || 1;
  } else if (mode === 'minmax') {
    center = stats.min;
    scale = stats.max - stats.min || 1;
  } else if (mode === 'quantile') {
    center = 0;
    scale = 1;
  } else {
    // log / standard は変換後サンプルから平均・標準偏差を求める
    const s = sortedSample(values, 20000);
    let sum = 0;
    let sum2 = 0;
    for (let i = 0; i < s.length; i++) {
      const v = map(s[i]);
      sum += v;
      sum2 += v * v;
    }
    const n = Math.max(1, s.length);
    center = sum / n;
    const variance = sum2 / n - center * center;
    scale = Math.sqrt(Math.max(variance, 1e-12));
    if (!Number.isFinite(scale) || scale === 0) scale = 1;
  }

  const imputed = (map(stats.median) - center) / scale;
  const dims = withIndicator ? 2 : 1;
  const groupScale = (spec.weight / Math.sqrt(dims)) || 0;
  const indicatorP = missingRate;
  const indicatorSd = Math.sqrt(Math.max(indicatorP * (1 - indicatorP), 1e-6));

  const meta: FeatureMeta[] = [
    { column: spec.name, label: spec.name, columnIndex: spec.index, type: 'numeric' },
  ];
  if (withIndicator) {
    meta.push({
      column: spec.name,
      label: `${spec.name}（未入力）`,
      columnIndex: spec.index,
      type: 'numeric',
    });
  }

  return {
    dims,
    meta,
    writeBlock(rows, out, totalDim, offset) {
      const n = rows.length;
      for (let r = 0; r < n; r++) {
        const raw = values[rows[r]];
        let v: number;
        if (Number.isFinite(raw)) {
          v = (map(raw) - center) / scale;
          if (v > 6) v = 6;
          else if (v < -6) v = -6;
        } else {
          v = imputed;
        }
        out[r * totalDim + offset] = v * groupScale;
      }
      if (withIndicator) {
        for (let r = 0; r < n; r++) {
          const miss = Number.isFinite(values[rows[r]]) ? 0 : 1;
          out[r * totalDim + offset + 1] = ((miss - indicatorP) / indicatorSd) * groupScale;
        }
      }
    },
  };
}

function makeCategoricalEncoder(
  column: Extract<ColumnData, { kind: 'categorical' }>,
  rowCount: number,
): ColumnEncoder {
  const spec = column.spec;
  const codes = column.codes;
  const stats = column.stats;
  const minCount = Math.max(5, Math.floor(rowCount * 0.002));

  const chosen = stats.levels
    .filter((l) => l.count >= minCount)
    .slice(0, MAX_ONEHOT_LEVELS);

  // code -> dummy index
  const codeToDummy = new Int32Array(column.dictionary.length).fill(-1);
  const dictIndex = new Map<string, number>();
  for (let i = 0; i < column.dictionary.length; i++) dictIndex.set(column.dictionary[i], i);
  const labels: string[] = [];
  let coveredCount = 0;
  for (let i = 0; i < chosen.length; i++) {
    const code = dictIndex.get(chosen[i].value);
    if (code === undefined) continue;
    codeToDummy[code] = labels.length;
    labels.push(chosen[i].value);
    coveredCount += chosen[i].count;
  }

  const otherCount = stats.count - coveredCount;
  const otherDummy = otherCount >= minCount ? labels.length : -1;
  if (otherDummy >= 0) labels.push('その他');

  const missingRate = rowCount > 0 ? stats.missing / rowCount : 0;
  const missingDummy =
    missingRate >= MISSING_INDICATOR_MIN_RATE ? labels.length : -1;
  if (missingDummy >= 0) labels.push('（未入力）');

  const dims = labels.length;
  const counts = new Float64Array(dims);
  for (let i = 0; i < chosen.length; i++) {
    const code = dictIndex.get(chosen[i].value);
    if (code !== undefined && codeToDummy[code] >= 0) counts[codeToDummy[code]] = chosen[i].count;
  }
  if (otherDummy >= 0) counts[otherDummy] = otherCount;
  if (missingDummy >= 0) counts[missingDummy] = stats.missing;

  const p = new Float64Array(dims);
  const invSd = new Float64Array(dims);
  for (let j = 0; j < dims; j++) {
    p[j] = rowCount > 0 ? counts[j] / rowCount : 0;
    invSd[j] = 1 / Math.sqrt(Math.max(p[j] * (1 - p[j]), 1e-6));
  }
  const groupScale = dims > 0 ? spec.weight / Math.sqrt(dims) : 0;

  const meta: FeatureMeta[] = labels.map((level) => ({
    column: spec.name,
    label: `${spec.name} = ${level}`,
    columnIndex: spec.index,
    type: 'onehot' as const,
    level,
  }));

  return {
    dims,
    meta,
    writeBlock(rows, out, totalDim, offset) {
      const n = rows.length;
      // まず「その列の平均を引いた値」で全次元を埋める（= 0 のときの値）
      for (let j = 0; j < dims; j++) {
        const base = -p[j] * invSd[j] * groupScale;
        for (let r = 0; r < n; r++) out[r * totalDim + offset + j] = base;
      }
      const one = new Float64Array(dims);
      for (let j = 0; j < dims; j++) one[j] = (1 - p[j]) * invSd[j] * groupScale;
      for (let r = 0; r < n; r++) {
        const code = codes[rows[r]];
        let dummy: number;
        if (code < 0) dummy = missingDummy;
        else {
          dummy = codeToDummy[code];
          if (dummy < 0) dummy = otherDummy;
        }
        if (dummy >= 0) out[r * totalDim + offset + dummy] = one[dummy];
      }
    },
  };
}

/** データセットと列設定からエンコード計画を作る */
export function buildEncodePlan(dataset: Dataset): EncodePlan {
  const encoders: ColumnEncoder[] = [];
  const features: FeatureMeta[] = [];
  const usedColumns: string[] = [];

  for (const column of dataset.columns) {
    if (column.spec.role !== 'feature') continue;
    if (column.spec.weight <= 0) continue;
    let enc: ColumnEncoder;
    if (column.kind === 'numeric') {
      if (column.stats.count === 0 || column.stats.sd === 0) continue;
      enc = makeNumericEncoder(column, dataset.rowCount);
    } else {
      if (column.stats.distinct <= 1) continue;
      enc = makeCategoricalEncoder(column, dataset.rowCount);
      if (enc.dims <= 1) continue; // 実質定数
    }
    encoders.push(enc);
    features.push(...enc.meta);
    usedColumns.push(column.spec.name);
  }

  const dim = features.length;
  if (dim === 0) {
    throw new Error(
      '特徴量が作れませんでした。値のばらつきがある列を「特徴量」に設定してください。',
    );
  }

  return {
    dim,
    features,
    encoders,
    usedColumns,
    encodeRows(rows: Int32Array, out?: Float32Array): Float32Array {
      const buffer = out && out.length >= rows.length * dim ? out : new Float32Array(rows.length * dim);
      let offset = 0;
      for (const enc of encoders) {
        enc.writeBlock(rows, buffer, dim, offset);
        offset += enc.dims;
      }
      return buffer;
    },
  };
}

/** 連番の行インデックスを作る（ブロック処理用） */
export function rangeIndices(start: number, end: number, reuse?: Int32Array): Int32Array {
  const n = end - start;
  const arr = reuse && reuse.length === n ? reuse : new Int32Array(n);
  for (let i = 0; i < n; i++) arr[i] = start + i;
  return arr;
}

/** 数値列の分位点（欠損補完値の確認などに使う） */
export function medianOf(values: Float64Array): number {
  return quantileSorted(sortedSample(values), 0.5);
}
