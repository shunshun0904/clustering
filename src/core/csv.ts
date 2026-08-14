/**
 * ストリーミング CSV / TSV パーサ。
 * - RFC4180 のクォート（"" によるエスケープ、改行・区切り文字の埋め込み）に対応
 * - 行ごとにコールバックへ渡すので、数十万行でも中間配列を作らない
 * - パフォーマンスのため fields 配列は使い回す（コールバック内で即座に読むこと）
 */

export type RowSink = (fields: string[], fieldCount: number) => void;

const CH_QUOTE = 34;
const CH_LF = 10;
const CH_CR = 13;

export class CsvParser {
  private readonly delimCode: number;
  private readonly sink: RowSink;
  private fields: string[] = [];
  private fieldCount = 0;
  private current = '';
  private inQuotes = false;
  /** クォート内で " を読んだ直後（"" or 閉じクォートの判定待ち） */
  private quotePending = false;
  /** \r を読んだ直後（\r\n をまとめるため） */
  private crPending = false;
  /** 現在のフィールドに 1 文字でも入ったか（先頭クォートの判定用） */
  private started = false;

  constructor(delimiter: string, sink: RowSink) {
    this.delimCode = delimiter.charCodeAt(0);
    this.sink = sink;
  }

  /**
   * チャンクを流し込む。
   * 通常文字は 1 文字ずつ連結せず、区切り文字までまとめて slice するため
   * 数百 MB のファイルでも実用的な速度が出る。
   */
  write(chunk: string): void {
    const delim = this.delimCode;
    const n = chunk.length;
    let i = 0;
    /** まだ current に取り込んでいない平文の開始位置 */
    let seg = 0;

    while (i < n) {
      const c = chunk.charCodeAt(i);

      if (this.crPending) {
        this.crPending = false;
        if (c === CH_LF) {
          i++;
          seg = i;
          continue;
        }
      }

      if (this.quotePending) {
        this.quotePending = false;
        if (c === CH_QUOTE) {
          this.current += '"';
          i++;
          seg = i;
          continue;
        }
        this.inQuotes = false;
        // フォールスルーして通常処理へ
      }

      if (this.inQuotes) {
        const q = chunk.indexOf('"', i);
        if (q === -1) {
          this.current += chunk.slice(i);
          seg = n;
          i = n;
          break;
        }
        this.current += chunk.slice(i, q);
        this.quotePending = true;
        i = q + 1;
        seg = i;
        continue;
      }

      if (c === CH_QUOTE && !this.started && this.current === '') {
        this.inQuotes = true;
        this.started = true;
        i++;
        seg = i;
        continue;
      }
      if (c === delim) {
        this.pushField(chunk, seg, i);
        i++;
        seg = i;
        continue;
      }
      if (c === CH_LF) {
        this.endRow(chunk, seg, i);
        i++;
        seg = i;
        continue;
      }
      if (c === CH_CR) {
        this.crPending = true;
        this.endRow(chunk, seg, i);
        i++;
        seg = i;
        continue;
      }
      this.started = true;
      i++;
    }

    if (seg < n) this.current += chunk.slice(seg, n);
  }

  end(): void {
    if (this.current !== '' || this.fieldCount > 0 || this.started) {
      this.endRow('', 0, 0);
    }
  }

  /**
   * フィールドを確定する。
   * クォートを含まない一般的なケースでは current への連結を挟まず、
   * チャンクから直接 slice する（1 フィールドあたりの割り当てが 1 回で済む）。
   */
  private pushField(chunk: string, from: number, to: number): void {
    let value: string;
    if (this.current === '') {
      value = from < to ? chunk.slice(from, to) : '';
    } else {
      value = from < to ? this.current + chunk.slice(from, to) : this.current;
    }
    if (this.fieldCount < this.fields.length) {
      this.fields[this.fieldCount] = value;
    } else {
      this.fields.push(value);
    }
    this.fieldCount++;
    this.current = '';
    this.started = false;
  }

  private endRow(chunk: string, from: number, to: number): void {
    this.pushField(chunk, from, to);
    // 完全な空行はスキップ
    if (!(this.fieldCount === 1 && this.fields[0] === '')) {
      this.sink(this.fields, this.fieldCount);
    }
    this.fieldCount = 0;
    this.inQuotes = false;
    this.quotePending = false;
  }
}

/** テキスト全体を一括でパースする（テストや小さいサンプル用）。 */
export function parseCsvText(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  const parser = new CsvParser(delimiter, (fields, count) => {
    rows.push(fields.slice(0, count));
  });
  parser.write(text);
  parser.end();
  return rows;
}

const CANDIDATE_DELIMITERS = [',', '\t', ';', '|'];

/**
 * 区切り文字の自動判定。
 * 先頭数行について「クォート外での出現数」を数え、行ごとのばらつきが小さく
 * かつ 1 行あたりの出現数が多いものを選ぶ。
 */
export function detectDelimiter(sample: string): string {
  const lines = splitLinesOutsideQuotes(sample, 20);
  if (lines.length === 0) return ',';

  let best = ',';
  let bestScore = -Infinity;
  for (const delim of CANDIDATE_DELIMITERS) {
    const counts = lines.map((line) => countOutsideQuotes(line, delim));
    const nonZero = counts.filter((c) => c > 0).length;
    if (nonZero === 0) continue;
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance =
      counts.reduce((a, b) => a + (b - mean) * (b - mean), 0) / counts.length;
    // 出現数が多く、行ごとに安定しているほど高スコア
    const score = mean - variance * 2 + (nonZero / counts.length) * 2;
    if (score > bestScore) {
      bestScore = score;
      best = delim;
    }
  }
  return best;
}

function splitLinesOutsideQuotes(text: string, maxLines: number): string[] {
  const out: string[] = [];
  let inQuotes = false;
  let start = 0;
  for (let i = 0; i < text.length && out.length < maxLines; i++) {
    const ch = text[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (i > start) out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (out.length < maxLines && start < text.length) out.push(text.slice(start));
  return out.filter((l) => l.trim() !== '');
}

function countOutsideQuotes(line: string, delim: string): number {
  let inQuotes = false;
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === delim && !inQuotes) count++;
  }
  return count;
}

/**
 * 文字コードの判定。日本語の業務データは Shift_JIS(CP932) 書き出しが多いため、
 * UTF-8 として不正なら CP932 とみなす。
 */
export function detectEncoding(head: Uint8Array): string {
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
    return 'utf-8';
  }
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return 'utf-16le';
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return 'utf-16be';

  // マルチバイト境界で切れている可能性があるので末尾 4 バイトは落として検査
  const probe = head.subarray(0, Math.max(0, head.length - 4));
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(probe);
    return 'utf-8';
  } catch {
    return 'shift_jis';
  }
}

export function makeDecoder(encoding: string): TextDecoder {
  try {
    return new TextDecoder(encoding, { ignoreBOM: false });
  } catch {
    return new TextDecoder('utf-8');
  }
}

/** ヘッダー名の正規化（BOM 除去・前後空白除去・空名の補完）。 */
export function normalizeHeader(fields: string[], count: number): string[] {
  const out: string[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    let name = fields[i].replace(/^﻿/, '').trim();
    if (name === '') name = `列${i + 1}`;
    const prev = seen.get(name);
    if (prev === undefined) {
      seen.set(name, 1);
    } else {
      seen.set(name, prev + 1);
      name = `${name}_${prev + 1}`;
    }
    out.push(name);
  }
  return out;
}
