import type { ColumnKind, ColumnRole, ColumnSpec, NumericTransform } from './types.ts';

/** 欠損とみなす文字列 */
const NULL_TOKENS = new Set([
  '',
  'na',
  'n/a',
  'null',
  'nil',
  'none',
  'nan',
  '-',
  '--',
  '#n/a',
  '#null!',
  '(null)',
  '不明',
  '未設定',
  '未入力',
  'なし',
  '該当なし',
]);

export function isMissing(raw: string): boolean {
  if (raw === '') return true;
  // 数字始まりは欠損トークンになり得ないので、trim/toLowerCase を回避する。
  // 数十万行 × 数百列だとこの割り当てだけで数秒変わる。
  const c0 = raw.charCodeAt(0);
  if ((c0 >= 48 && c0 <= 57) || ((c0 === 45 || c0 === 43) && raw.length > 1)) return false;
  const t = raw.trim();
  if (t === '') return true;
  return NULL_TOKENS.has(t.toLowerCase());
}

const TRUE_TOKENS = new Set(['true', 'yes', 'y', 't', '1', 'はい', '有', '有り', 'あり', '○', '◯', '〇', 'ok']);
const FALSE_TOKENS = new Set(['false', 'no', 'n', 'f', '0', 'いいえ', '無', '無し', 'なし', '×', '✕', 'ng']);

export function parseBooleanLoose(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  if (TRUE_TOKENS.has(t)) return 1;
  if (FALSE_TOKENS.has(t)) return 0;
  return null;
}

/** 全角数字・記号を半角に寄せる */
function toHalfWidth(s: string): string {
  return s.replace(/[０-９．，－＋％]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  );
}

/**
 * 業務データにありがちな表記を許容する数値パーサ。
 * "1,234" "¥1,234" "12.5%" "(1,200)"（負数）"１２３"（全角）などに対応。
 * 数値として読めなければ NaN。
 */
export function parseNumberLoose(raw: string): number {
  // 高速パス: 半角数字・小数点・符号だけで構成されていれば Number() に直行する。
  // 実データの大半はここで終わるので、全体のパース時間が大きく変わる。
  const len = raw.length;
  if (len > 0 && len < 24) {
    let simple = true;
    for (let i = 0; i < len; i++) {
      const c = raw.charCodeAt(i);
      if ((c >= 48 && c <= 57) || c === 46 || c === 45 || c === 43) continue;
      simple = false;
      break;
    }
    if (simple) {
      const v = +raw;
      return Number.isFinite(v) ? v : NaN;
    }
  }

  let s = raw.trim();
  if (s === '') return NaN;
  if (/[０-９．，－＋％]/.test(s)) s = toHalfWidth(s);

  let sign = 1;
  // 会計表記の (1,200) は負数
  if (s.length > 2 && s.charCodeAt(0) === 40 && s.charCodeAt(s.length - 1) === 41) {
    sign = -1;
    s = s.slice(1, -1);
  }
  let percent = false;
  if (s.endsWith('%')) {
    percent = true;
    s = s.slice(0, -1);
  }
  // 通貨記号・単位・カンマ・空白を除去
  s = s.replace(/^[¥$€£₩]/, '').replace(/[,\s_]/g, '').replace(/円$/, '');
  if (s === '' || s === '-' || s === '+' || s === '.') return NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return NaN;
  const v = Number(s);
  if (!Number.isFinite(v)) return NaN;
  return sign * (percent ? v / 100 : v);
}

const DATE_PATTERNS: RegExp[] = [
  /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
  /^(\d{4})(\d{2})(\d{2})$/,
];

/** 日付を epoch ミリ秒で返す。読めなければ NaN。 */
export function parseDateLoose(raw: string): number {
  const s = raw.trim();
  if (s === '') return NaN;
  for (let p = 0; p < DATE_PATTERNS.length; p++) {
    const m = DATE_PATTERNS[p].exec(s);
    if (!m) continue;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (year < 1900 || year > 2200) return NaN;
    if (month < 1 || month > 12 || day < 1 || day > 31) return NaN;
    const hour = m[4] ? Number(m[4]) : 0;
    const min = m[5] ? Number(m[5]) : 0;
    const sec = m[6] ? Number(m[6]) : 0;
    return Date.UTC(year, month - 1, day, hour, min, sec);
  }
  return NaN;
}

/** 日付列は epoch 日数（1970-01-01 起点）で保持する */
export const MS_PER_DAY = 86400000;

const ID_NAME = /(^|[ _\-])(id|uid|uuid|key|code|no)([ _\-]|$)|コード$|番号$|^id$/i;

/** 文章っぽさの判定に使う記号 */
const SENTENCE_MARKERS = /[。、．，]|\.\s|\?|？|！|!/;

/**
 * 自由記述かどうか。
 * 日本語は 1 文が短いので、文字数だけでなく句読点の出現率も見る。
 */
function isFreeText(avgLength: number, punctRate: number): boolean {
  if (avgLength > 28) return true;
  if (punctRate >= 0.4 && avgLength >= 12) return true;
  return false;
}

export interface InferInput {
  name: string;
  index: number;
  /** サンプル行の生値 */
  values: string[];
}

/** サンプルから 1 列の型・役割・変換方法を推定する */
export function inferColumn(input: InferInput): ColumnSpec {
  const { name, index, values } = input;
  const total = values.length;
  const nonNull: string[] = [];
  for (let i = 0; i < total; i++) {
    if (!isMissing(values[i])) nonNull.push(values[i]);
  }
  const filled = nonNull.length;
  const fillRate = total > 0 ? filled / total : 0;

  const distinctSet = new Set<string>();
  let lengthSum = 0;
  let punctuated = 0;
  for (let i = 0; i < nonNull.length; i++) {
    const v = nonNull[i];
    if (distinctSet.size < 5000) distinctSet.add(v);
    lengthSum += v.length;
    // 句読点や文末記号があれば文章の可能性が高い（日本語は 1 文が短いので長さだけでは判別しづらい）
    if (SENTENCE_MARKERS.test(v)) punctuated++;
  }
  const distinctCount = distinctSet.size;
  const avgLength = filled > 0 ? lengthSum / filled : 0;
  const punctRate = filled > 0 ? punctuated / filled : 0;

  let numericOk = 0;
  let boolOk = 0;
  let dateOk = 0;
  const probe = Math.min(nonNull.length, 1000);
  for (let i = 0; i < probe; i++) {
    const v = nonNull[i];
    if (Number.isFinite(parseNumberLoose(v))) numericOk++;
    if (parseBooleanLoose(v) !== null) boolOk++;
    if (Number.isFinite(parseDateLoose(v))) dateOk++;
  }
  const numericRate = probe > 0 ? numericOk / probe : 0;
  const boolRate = probe > 0 ? boolOk / probe : 0;
  const dateRate = probe > 0 ? dateOk / probe : 0;
  const distinctRatio = filled > 0 ? distinctCount / Math.min(filled, 5000) : 0;

  let kind: ColumnKind;
  let note: string;

  if (filled === 0 || fillRate < 0.02) {
    kind = 'empty';
    note = 'ほぼ全て欠損';
  } else if (distinctCount <= 1) {
    kind = 'constant';
    note = '値が1種類のみ';
  } else if (dateRate >= 0.9 && numericRate < 0.9) {
    kind = 'datetime';
    note = '日付として解釈';
  } else if (distinctCount === 2 && boolRate >= 0.95) {
    kind = 'boolean';
    note = '2値フラグ';
  } else if (numericRate >= 0.92) {
    // 一意な整数 + ID っぽい名前なら識別子
    const looksId = ID_NAME.test(name) && distinctRatio > 0.95;
    if (looksId) {
      kind = 'identifier';
      note = 'ID列とみなして除外';
    } else {
      kind = 'numeric';
      note = '数値';
    }
  } else if (dateRate >= 0.7) {
    kind = 'datetime';
    note = '日付として解釈（一部読めない値あり）';
  } else if (ID_NAME.test(name) && distinctRatio > 0.95 && filled >= 4) {
    kind = 'identifier';
    note = 'ID列とみなして除外';
  } else if (distinctRatio > 0.9 && filled >= 30 && !isFreeText(avgLength, punctRate)) {
    kind = avgLength <= 24 ? 'identifier' : 'text';
    note = 'ほぼ全行で値が異なるため除外';
  } else if (isFreeText(avgLength, punctRate)) {
    kind = 'text';
    note = '自由記述とみなして除外';
  } else {
    kind = 'categorical';
    note = `カテゴリ（${distinctCount >= 5000 ? '5000+' : distinctCount}種）`;
  }

  const role = defaultRole(kind, distinctCount);
  const transform: NumericTransform = 'auto';

  return {
    index,
    name,
    kind,
    inferredKind: kind,
    role,
    transform,
    weight: 1,
    fillRate,
    distinctCount,
    note,
    sampleValues: nonNull.slice(0, 5),
  };
}

/** 高カーディナリティのカテゴリはワンホットに向かないので既定はプロファイル用途 */
export const CATEGORICAL_FEATURE_LIMIT = 50;

export function defaultRole(kind: ColumnKind, distinctCount: number): ColumnRole {
  switch (kind) {
    case 'numeric':
    case 'boolean':
    case 'datetime':
      return 'feature';
    case 'categorical':
      return distinctCount <= CATEGORICAL_FEATURE_LIMIT ? 'feature' : 'profile';
    default:
      return 'ignore';
  }
}

/** その kind が数値列として保持されるか（categorical は辞書 + コードで保持） */
export function isNumericKind(kind: ColumnKind): boolean {
  return kind === 'numeric' || kind === 'boolean' || kind === 'datetime';
}

/** 生値を、その列の保持形式に合わせて数値化する */
export function parseValueAs(kind: ColumnKind, raw: string): number {
  if (isMissing(raw)) return NaN;
  switch (kind) {
    case 'numeric':
      return parseNumberLoose(raw);
    case 'boolean': {
      const b = parseBooleanLoose(raw);
      if (b !== null) return b;
      return parseNumberLoose(raw);
    }
    case 'datetime': {
      const d = parseDateLoose(raw);
      return Number.isFinite(d) ? d / MS_PER_DAY : NaN;
    }
    default:
      return NaN;
  }
}
