/**
 * クラスタ用の色。色覚特性に配慮して、明度と色相の両方を離してある。
 */
const CLUSTER_COLORS = [
  '#3b62f6',
  '#f5871f',
  '#0f9d76',
  '#d6336c',
  '#7048e8',
  '#0ea5e9',
  '#b45309',
  '#15803d',
  '#be123c',
  '#4338ca',
  '#0891b2',
  '#a16207',
  '#166534',
  '#9d174d',
  '#5b21b6',
  '#155e75',
];

export function clusterColor(index: number): string {
  return CLUSTER_COLORS[index % CLUSTER_COLORS.length];
}

/** 効果量（z）を背景色に変換する。正=青、負=橙。 */
export function heatColor(z: number, max = 1.5): string {
  const t = Math.max(-1, Math.min(1, z / max));
  const alpha = Math.abs(t) * 0.32;
  if (alpha < 0.02) return 'transparent';
  return t > 0
    ? `color-mix(in srgb, #3b62f6 ${(alpha * 100).toFixed(0)}%, transparent)`
    : `color-mix(in srgb, #f5871f ${(alpha * 100).toFixed(0)}%, transparent)`;
}

/** リフト（1 が平均）を背景色に変換する */
export function liftColor(lift: number): string {
  if (!Number.isFinite(lift) || lift <= 0) return 'transparent';
  return heatColor(Math.log2(lift), 1.2);
}
