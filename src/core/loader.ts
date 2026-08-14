import { CsvParser, detectDelimiter, normalizeHeader } from './csv.ts';
import { ColumnBuilder } from './columns.ts';
import { inferColumn } from './infer.ts';
import type { ColumnSpec, Dataset } from './types.ts';
import type { TextSource } from './source.ts';

export interface InspectResult {
  specs: ColumnSpec[];
  previewHeader: string[];
  previewRows: string[][];
  /** ファイルサイズとサンプルから推定した総行数 */
  estimatedRows: number;
  delimiter: string;
  encoding: string;
  warnings: string[];
}

const INSPECT_BYTES = 2 << 20; // 2MB ぶん読んで推定する
const INSPECT_ROWS = 5000;
const PREVIEW_ROWS = 30;

/**
 * ファイルの先頭だけを読んで、列の型・役割を推定する。
 * ここで「使う列」を確定させてから全件を読むことで、
 * 不要な列（自由記述や ID）を一切メモリに載せずに済む。
 */
export async function inspectSource(source: TextSource): Promise<InspectResult> {
  const { text, encoding } = await source.head(INSPECT_BYTES);
  const warnings: string[] = [];
  if (text.trim() === '') {
    throw new Error('ファイルが空です。ヘッダー行を含む CSV / TSV を指定してください。');
  }
  const delimiter = detectDelimiter(text);

  let header: string[] | null = null;
  const rows: string[][] = [];
  /** head 内で見えたデータ行の総数（サンプル上限とは別に数える） */
  let seenRows = 0;
  let truncated = false;
  const parser = new CsvParser(delimiter, (fields, count) => {
    if (header === null) {
      header = normalizeHeader(fields, count);
      return;
    }
    seenRows++;
    if (rows.length < INSPECT_ROWS) {
      const row = new Array<string>(header.length);
      for (let i = 0; i < header.length; i++) row[i] = i < count ? fields[i] : '';
      rows.push(row);
      if (count > header.length) truncated = true;
    }
  });
  parser.write(text);
  // 先頭だけを読んでいるので、末尾の行は不完全な可能性がある → end() は呼ばず捨てる
  if (source.size <= INSPECT_BYTES) parser.end();

  if (header === null) {
    throw new Error('ヘッダー行を読み取れませんでした。');
  }
  const head: string[] = header;
  if (rows.length === 0) {
    throw new Error('データ行がありません。ヘッダーの次の行以降にデータが必要です。');
  }
  if (truncated) {
    warnings.push('ヘッダーより列数が多い行があります。余分な列は無視します。');
  }
  if (head.length > 2000) {
    warnings.push(`列数が ${head.length} 列と非常に多いため、処理に時間がかかります。`);
  }

  const specs: ColumnSpec[] = [];
  const columnValues: string[] = new Array(rows.length);
  for (let c = 0; c < head.length; c++) {
    for (let r = 0; r < rows.length; r++) columnValues[r] = rows[r][c];
    specs.push(inferColumn({ name: head[c], index: c, values: columnValues }));
  }

  // 総行数の推定。
  // ファイル全体が head に収まっているなら実数、そうでなければ
  // 「head 部分の 1 行あたりバイト数」から外挿する。
  const sampledBytes = Math.min(source.size, text.length);
  const bytesPerRow = seenRows > 0 ? sampledBytes / (seenRows + 1) : 1;
  const estimatedRows =
    source.size <= INSPECT_BYTES ? seenRows : Math.round(source.size / bytesPerRow);

  const featureCount = specs.filter((s) => s.role === 'feature').length;
  if (featureCount === 0) {
    warnings.push(
      '自動判定では特徴量にできる列が見つかりませんでした。列設定で「特徴量」に変更してください。',
    );
  }

  return {
    specs,
    previewHeader: head,
    previewRows: rows.slice(0, PREVIEW_ROWS),
    estimatedRows,
    delimiter,
    encoding,
    warnings,
  };
}

export interface LoadOptions {
  delimiter: string;
  estimatedRows: number;
  /** 読み込む最大行数。超える場合は等間隔に間引く（0/未指定なら全件） */
  maxRows?: number;
  onProgress?: (ratio: number, rowsRead: number) => void;
}

/**
 * 指定された列だけを全件読み込み、列指向のデータセットを作る。
 * role === 'ignore' の列は一切保持しない。
 */
export async function loadDataset(
  source: TextSource,
  specs: ColumnSpec[],
  options: LoadOptions,
): Promise<Dataset> {
  const kept = specs.filter((s) => s.role !== 'ignore');
  if (kept.length === 0) {
    throw new Error('読み込む列がありません。少なくとも 1 列を「特徴量」にしてください。');
  }
  const builders = kept.map((s) => new ColumnBuilder(s, options.estimatedRows));
  const keptIndices = kept.map((s) => s.index);
  const columnCount = specs.length;

  // 巨大ファイルは等間隔に間引いて読む（メモリ上限を超えないための逃げ道）
  const maxRows = options.maxRows ?? 0;
  const stride =
    maxRows > 0 && options.estimatedRows > maxRows
      ? Math.ceil(options.estimatedRows / maxRows)
      : 1;

  let header: string[] | null = null;
  let rowCount = 0;
  let sourceRowCount = 0;
  let ragged = 0;
  const previewRows: string[][] = [];
  const previewHeader = specs.map((s) => s.name);
  const nKept = keptIndices.length;

  const parser = new CsvParser(options.delimiter, (fields, count) => {
    if (header === null) {
      header = normalizeHeader(fields, count);
      return;
    }
    const sourceIndex = sourceRowCount++;
    if (stride > 1 && sourceIndex % stride !== 0) return;
    if (count < columnCount) ragged++;
    for (let i = 0; i < nKept; i++) {
      const src = keptIndices[i];
      builders[i].push(src < count ? fields[src] : '');
    }
    if (previewRows.length < PREVIEW_ROWS) {
      const row = new Array<string>(columnCount);
      for (let i = 0; i < columnCount; i++) row[i] = i < count ? fields[i] : '';
      previewRows.push(row);
    }
    rowCount++;
  });

  await source.stream(
    (chunk) => parser.write(chunk),
    (bytes, total) => {
      if (total > 0) options.onProgress?.(bytes / total, rowCount);
    },
  );
  parser.end();

  if (rowCount === 0) throw new Error('データ行が 0 件でした。');

  const warnings: string[] = [];
  if (ragged > 0) {
    warnings.push(`${ragged.toLocaleString()} 行で列数が不足していました（欠損として処理）。`);
  }
  if (stride > 1) {
    warnings.push(
      `全 ${sourceRowCount.toLocaleString()} 行から ${stride} 行おきに ${rowCount.toLocaleString()} 行を抽出して分析しています。`,
    );
  }
  const columns = builders.map((b) => {
    if (b.overflowCount > 0) {
      warnings.push(
        `列「${b.spec.name}」のカテゴリ数が上限を超えたため、一部を欠損として扱いました。`,
      );
    }
    return b.finish(rowCount);
  });

  return {
    rowCount,
    columns,
    previewRows,
    previewHeader,
    warnings,
    sourceRowCount,
    sampleStride: stride,
  };
}
