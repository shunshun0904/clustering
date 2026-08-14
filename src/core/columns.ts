import type { CategoryStats, ColumnData, ColumnSpec } from './types.ts';
import { computeNumericStats } from './stats.ts';
import { isMissing, isNumericKind, parseValueAs } from './infer.ts';

/**
 * 行数が事前に分からないので、倍々で伸ばす可変長の型付き配列を使う。
 * 文字列のまま全行を保持すると数十万行 × 数百列でメモリが破綻するため、
 * 数値は Float64Array、カテゴリは辞書 + Int32Array のコードで持つ。
 */
class GrowableFloat64 {
  private buf: Float64Array;
  length = 0;
  constructor(initial = 4096) {
    this.buf = new Float64Array(initial);
  }
  push(v: number): void {
    if (this.length === this.buf.length) {
      const next = new Float64Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.length++] = v;
  }
  /** 指定長に合わせて確定させる（不足分は NaN 埋め） */
  finish(rowCount: number): Float64Array {
    while (this.length < rowCount) this.push(NaN);
    return this.buf.length === rowCount ? this.buf : this.buf.slice(0, rowCount);
  }
}

class GrowableInt32 {
  private buf: Int32Array;
  length = 0;
  constructor(initial = 4096) {
    this.buf = new Int32Array(initial);
  }
  push(v: number): void {
    if (this.length === this.buf.length) {
      const next = new Int32Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.length++] = v;
  }
  finish(rowCount: number): Int32Array {
    while (this.length < rowCount) this.push(-1);
    return this.buf.length === rowCount ? this.buf : this.buf.slice(0, rowCount);
  }
}

/** カテゴリ数の上限。これを超えたら以降は「その他」に丸める */
export const MAX_DICTIONARY_SIZE = 20000;

/** 1 列ぶんのビルダー */
export class ColumnBuilder {
  readonly spec: ColumnSpec;
  private readonly numeric: GrowableFloat64 | null;
  private readonly codes: GrowableInt32 | null;
  private readonly dict: string[] = [];
  private readonly dictIndex = new Map<string, number>();
  private missing = 0;
  private overflow = 0;

  constructor(spec: ColumnSpec, expectedRows: number) {
    this.spec = spec;
    const initial = Math.max(4096, Math.min(expectedRows || 4096, 1 << 20));
    if (isNumericKind(spec.kind)) {
      this.numeric = new GrowableFloat64(initial);
      this.codes = null;
    } else {
      this.numeric = null;
      this.codes = new GrowableInt32(initial);
    }
  }

  push(raw: string): void {
    if (this.numeric) {
      const v = parseValueAs(this.spec.kind, raw);
      if (!Number.isFinite(v)) this.missing++;
      this.numeric.push(v);
      return;
    }
    const codes = this.codes!;
    if (isMissing(raw)) {
      this.missing++;
      codes.push(-1);
      return;
    }
    const key = raw.trim();
    let code = this.dictIndex.get(key);
    if (code === undefined) {
      if (this.dict.length >= MAX_DICTIONARY_SIZE) {
        this.overflow++;
        codes.push(-1);
        return;
      }
      code = this.dict.length;
      this.dict.push(key);
      this.dictIndex.set(key, code);
    }
    codes.push(code);
  }

  finish(rowCount: number): ColumnData {
    if (this.numeric) {
      const values = this.numeric.finish(rowCount);
      return {
        kind: 'numeric',
        spec: this.spec,
        values,
        stats: computeNumericStats(values),
      };
    }
    const codes = this.codes!.finish(rowCount);
    const counts = new Int32Array(this.dict.length);
    let missing = 0;
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c < 0) missing++;
      else counts[c]++;
    }
    const order: number[] = [];
    for (let i = 0; i < this.dict.length; i++) order.push(i);
    order.sort((a, b) => counts[b] - counts[a]);
    const levels = order
      .slice(0, 200)
      .map((i) => ({ value: this.dict[i], count: counts[i] }));
    const stats: CategoryStats = {
      count: codes.length - missing,
      missing,
      levels,
      distinct: this.dict.length,
    };
    return { kind: 'categorical', spec: this.spec, codes, dictionary: this.dict, stats };
  }

  get overflowCount(): number {
    return this.overflow;
  }

  get missingCount(): number {
    return this.missing;
  }
}
