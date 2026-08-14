import type { NumericStats } from './types.ts';

/** 昇順ソート済み配列からの分位点（線形補間）。 */
export function quantileSorted(sorted: Float64Array | number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const pos = (n - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * 数値列の要約統計。NaN は欠損として無視する。
 * 分位点は行数が多いとき最大 `sampleCap` 件のサンプルから推定する
 * （数十万行の完全ソートを毎回やらないため）。
 */
export function computeNumericStats(values: Float64Array, sampleCap = 200000): NumericStats {
  const n = values.length;
  let count = 0;
  let mean = 0;
  let m2 = 0;
  let m3 = 0;
  let min = Infinity;
  let max = -Infinity;

  // Welford で 1 パス（3 次モーメントまで）
  for (let i = 0; i < n; i++) {
    const x = values[i];
    if (!Number.isFinite(x)) continue;
    count++;
    const delta = x - mean;
    const deltaN = delta / count;
    const term1 = delta * deltaN * (count - 1);
    mean += deltaN;
    m3 += term1 * deltaN * (count - 2) - 3 * deltaN * m2;
    m2 += term1;
    if (x < min) min = x;
    if (x > max) max = x;
  }

  if (count === 0) {
    return {
      count: 0,
      missing: n,
      mean: 0,
      sd: 0,
      min: 0,
      max: 0,
      p01: 0,
      p25: 0,
      median: 0,
      p75: 0,
      p99: 0,
      skewness: 0,
    };
  }

  const variance = count > 1 ? m2 / (count - 1) : 0;
  const sd = Math.sqrt(Math.max(0, variance));
  const skewness =
    count > 2 && m2 > 0 ? (Math.sqrt(count) * m3) / Math.pow(m2, 1.5) : 0;

  // 分位点用サンプル
  const stride = count > sampleCap ? Math.ceil(count / sampleCap) : 1;
  const buf: number[] = [];
  let seen = 0;
  for (let i = 0; i < n; i++) {
    const x = values[i];
    if (!Number.isFinite(x)) continue;
    if (seen % stride === 0) buf.push(x);
    seen++;
  }
  buf.sort((a, b) => a - b);

  return {
    count,
    missing: n - count,
    mean,
    sd,
    min,
    max,
    p01: quantileSorted(buf, 0.01),
    p25: quantileSorted(buf, 0.25),
    median: quantileSorted(buf, 0.5),
    p75: quantileSorted(buf, 0.75),
    p99: quantileSorted(buf, 0.99),
    skewness,
  };
}

/** 逆正規分布（Acklam 近似）。分位点変換で使う。 */
export function probit(p: number): number {
  if (p <= 0) return -5;
  if (p >= 1) return 5;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q: number;
  let r: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  q = p - 0.5;
  r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

/** 昇順ソート済み配列で x 以下の要素数を二分探索。 */
export function lowerBound(sorted: Float64Array, x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
