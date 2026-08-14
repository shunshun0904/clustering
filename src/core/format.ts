import { MS_PER_DAY } from './infer.ts';
import type { ColumnKind } from './types.ts';

/** 桁数に応じて読みやすい丸め方をする */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)}兆`;
  if (abs >= 1e8) return `${(value / 1e8).toFixed(2)}億`;
  if (abs >= 1e4) return `${(value / 1e4).toFixed(abs >= 1e6 ? 1 : 2)}万`;
  if (abs >= 100) return value.toLocaleString('ja-JP', { maximumFractionDigits: 1 });
  if (abs >= 1) return value.toLocaleString('ja-JP', { maximumFractionDigits: 2 });
  if (abs >= 0.01) return value.toFixed(3);
  return value.toExponential(2);
}

export function formatDateFromDays(days: number): string {
  if (!Number.isFinite(days)) return '—';
  const date = new Date(days * MS_PER_DAY);
  const y = date.getUTCFullYear();
  const m = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const d = `${date.getUTCDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function formatByKind(kind: ColumnKind, value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (kind === 'datetime') return formatDateFromDays(value);
  if (kind === 'boolean') return `${(value * 100).toFixed(1)}%`;
  return formatNumber(value);
}

export function formatPercent(ratio: number, digits = 1): string {
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('ja-JP');
}

/** 全体平均に対する倍率の表記 */
export function formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '—';
  if (ratio >= 10) return `${ratio.toFixed(0)}倍`;
  return `${ratio.toFixed(2)}倍`;
}
