import { CsvParser, normalizeHeader } from './csv.ts';
import { formatByKind, formatPercent } from './format.ts';
import type { ClusterResult } from './types.ts';
import type { TextSource } from './source.ts';

/** CSV フィールドのエスケープ */
export function escapeCsv(value: string, delimiter: string): string {
  if (value === '') return '';
  if (
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r') ||
    value.includes(delimiter)
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toRow(values: (string | number)[], delimiter = ','): string {
  return values.map((v) => escapeCsv(String(v), delimiter)).join(delimiter);
}

/** Excel が UTF-8 と認識できるよう BOM を付ける */
export const UTF8_BOM = '﻿';

/**
 * 元ファイルを読み直して、セグメント列を追加した CSV を作る。
 * 元データをメモリに文字列で持たないので、数十万行でも扱える。
 */
export async function buildLabeledCsv(
  source: TextSource,
  delimiter: string,
  result: ClusterResult,
  onProgress?: (ratio: number) => void,
  /** 間引き読み込みをした場合の間隔。対象外の行はセグメント列を空にする */
  stride = 1,
): Promise<Blob> {
  const names = new Map<number, string>();
  for (const cluster of result.clusters) names.set(cluster.id, cluster.name);

  const chunks: string[] = [UTF8_BOM];
  let buffer: string[] = [];
  let header: string[] | null = null;
  let row = 0;
  const labels = result.labels;

  const parser = new CsvParser(delimiter, (fields, count) => {
    if (header === null) {
      header = normalizeHeader(fields, count);
      buffer.push(
        toRow([...header, 'segment_id', 'segment_name'], delimiter),
      );
      return;
    }
    const values: string[] = [];
    for (let i = 0; i < count; i++) values.push(fields[i]);
    const sourceIndex = row++;
    let label = -1;
    if (stride <= 1) {
      if (sourceIndex < labels.length) label = labels[sourceIndex];
    } else if (sourceIndex % stride === 0) {
      const target = sourceIndex / stride;
      if (target < labels.length) label = labels[target];
    }
    values.push(label >= 0 ? String(label + 1) : '');
    values.push(label >= 0 ? (names.get(label) ?? '') : '');
    buffer.push(toRow(values, delimiter));
    if (buffer.length >= 20000) {
      chunks.push(buffer.join('\n') + '\n');
      buffer = [];
    }
  });

  await source.stream(
    (chunk) => parser.write(chunk),
    (bytes, total) => {
      if (total > 0) onProgress?.(bytes / total);
    },
  );
  parser.end();
  if (buffer.length > 0) chunks.push(buffer.join('\n') + '\n');

  return new Blob(chunks, { type: 'text/csv;charset=utf-8' });
}

/** クラスタ × 列のプロファイル表を CSV にする */
export function buildProfileCsv(result: ClusterResult): Blob {
  const lines: string[] = [];
  const clusterNames = result.clusters.map((c) => `${c.id + 1}: ${c.name}`);

  lines.push(
    toRow(['列', '種別', '水準', '指標', '全体', ...clusterNames]),
  );

  for (const profile of result.profiles) {
    if (profile.kind === 'numeric') {
      const kind = profile.valueKind;
      lines.push(
        toRow([
          profile.column,
          '数値',
          '',
          '平均',
          formatByKind(kind, profile.overallMean),
          ...profile.clusters.map((c) => formatByKind(kind, c.mean)),
        ]),
      );
      lines.push(
        toRow([
          profile.column,
          '数値',
          '',
          '中央値',
          formatByKind(kind, profile.overallMedian),
          ...profile.clusters.map((c) => formatByKind(kind, c.median)),
        ]),
      );
      lines.push(
        toRow([
          profile.column,
          '数値',
          '',
          '効果量(z)',
          '0.00',
          ...profile.clusters.map((c) => c.z.toFixed(2)),
        ]),
      );
    } else {
      for (let s = 0; s < profile.levels.length; s++) {
        lines.push(
          toRow([
            profile.column,
            'カテゴリ',
            profile.levels[s],
            '構成比',
            formatPercent(profile.overallShare[s]),
            ...profile.clusters.map((c) => formatPercent(c.share[s])),
          ]),
        );
      }
    }
  }

  lines.push('');
  lines.push(toRow(['セグメント', '名称', '件数', '構成比', '主な特徴']));
  for (const cluster of result.clusters) {
    lines.push(
      toRow([
        cluster.id + 1,
        cluster.name,
        cluster.size,
        formatPercent(cluster.share),
        cluster.highlights.map((h) => h.text).join(' / '),
      ]),
    );
  }

  return new Blob([UTF8_BOM + lines.join('\n') + '\n'], {
    type: 'text/csv;charset=utf-8',
  });
}

/** クラスタ中心（元の特徴量空間ではなく、解釈しやすい平均値ベース）の要約 Markdown */
export function buildSummaryMarkdown(result: ClusterResult, fileName: string): Blob {
  const lines: string[] = [];
  lines.push(`# セグメンテーション結果: ${fileName}`);
  lines.push('');
  lines.push(`- 対象行数: ${result.labels.length.toLocaleString()} 行`);
  lines.push(`- セグメント数: ${result.k}（${result.chosenAutomatically ? '自動決定' : '手動指定'}）`);
  lines.push(`- 使用した列: ${result.usedColumns.join(', ')}`);
  lines.push(`- 特徴量次元: ${result.featureCount}（クラスタリングは ${result.reducedDim} 次元で実行）`);
  lines.push(`- シルエット係数: ${result.silhouette.toFixed(3)}`);
  lines.push('');

  lines.push('## セグメント一覧');
  lines.push('');
  lines.push('| # | 名称 | 件数 | 構成比 | 主な特徴 |');
  lines.push('| --- | --- | ---: | ---: | --- |');
  for (const cluster of result.clusters) {
    lines.push(
      `| ${cluster.id + 1} | ${cluster.name} | ${cluster.size.toLocaleString()} | ${formatPercent(cluster.share)} | ${cluster.highlights
        .map((h) => h.text)
        .join('<br>')} |`,
    );
  }
  lines.push('');

  lines.push('## 列ごとの平均値');
  lines.push('');
  const numericProfiles = result.profiles.filter((p) => p.kind === 'numeric');
  if (numericProfiles.length > 0) {
    lines.push(
      `| 列 | 全体 | ${result.clusters.map((c) => `${c.id + 1}`).join(' | ')} | 分離度 |`,
    );
    lines.push(`| --- | ---: | ${result.clusters.map(() => '---:').join(' | ')} | ---: |`);
    for (const profile of numericProfiles) {
      if (profile.kind !== 'numeric') continue;
      const kind = profile.valueKind;
      lines.push(
        `| ${profile.column} | ${formatByKind(kind, profile.overallMean)} | ${profile.clusters
          .map((c) => formatByKind(kind, c.mean))
          .join(' | ')} | ${profile.separation.toFixed(2)} |`,
      );
    }
    lines.push('');
  }

  const categoricalProfiles = result.profiles.filter((p) => p.kind === 'categorical');
  if (categoricalProfiles.length > 0) {
    lines.push('## カテゴリ列の構成比');
    lines.push('');
    for (const profile of categoricalProfiles) {
      if (profile.kind !== 'categorical') continue;
      lines.push(`### ${profile.column}（分離度 ${profile.separation.toFixed(2)}）`);
      lines.push('');
      lines.push(`| 水準 | 全体 | ${result.clusters.map((c) => `${c.id + 1}`).join(' | ')} |`);
      lines.push(`| --- | ---: | ${result.clusters.map(() => '---:').join(' | ')} |`);
      for (let s = 0; s < profile.levels.length; s++) {
        lines.push(
          `| ${profile.levels[s]} | ${formatPercent(profile.overallShare[s])} | ${profile.clusters
            .map((c) => formatPercent(c.share[s]))
            .join(' | ')} |`,
        );
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('AIクラスタリングで生成。データはブラウザ内でのみ処理されています。');

  return new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
}
