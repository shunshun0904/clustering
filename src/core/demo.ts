import { makeGaussian, makeRng } from './rng.ts';

/**
 * デモ用の合成データ（EC の顧客テーブル）。
 * 5 つの潜在セグメントを仕込んであるので、アプリの挙動確認に使える。
 */

interface Segment {
  name: string;
  share: number;
  age: [number, number];
  orders: [number, number];
  logAmount: [number, number];
  recencyDays: [number, number];
  openRate: [number, number];
  appDays: [number, number];
  couponRate: [number, number];
  returnRate: [number, number];
  rank: [number, number, number, number];
  category: number[];
  channel: number[];
}

const RANKS = ['ブロンズ', 'シルバー', 'ゴールド', 'プラチナ'];
const CATEGORIES = ['ファッション', 'コスメ', '食品', '家電', 'インテリア', '書籍'];
const CHANNELS = ['自然検索', '広告', 'SNS', 'メルマガ', '紹介'];
const PREFS = [
  '東京都', '神奈川県', '大阪府', '愛知県', '埼玉県', '千葉県', '福岡県',
  '北海道', '兵庫県', '静岡県', '広島県', '京都府',
];
const GENDERS = ['女性', '男性', '回答なし'];

const SEGMENTS: Segment[] = [
  {
    name: 'ロイヤル',
    share: 0.12,
    age: [44, 9],
    orders: [38, 12],
    logAmount: [13.2, 0.5],
    recencyDays: [12, 10],
    openRate: [0.62, 0.12],
    appDays: [22, 6],
    couponRate: [0.25, 0.1],
    returnRate: [0.03, 0.02],
    rank: [0.02, 0.1, 0.35, 0.53],
    category: [0.3, 0.25, 0.15, 0.1, 0.15, 0.05],
    channel: [0.35, 0.1, 0.1, 0.35, 0.1],
  },
  {
    name: '育成中',
    share: 0.24,
    age: [34, 8],
    orders: [9, 4],
    logAmount: [11.3, 0.5],
    recencyDays: [45, 25],
    openRate: [0.38, 0.14],
    appDays: [9, 4],
    couponRate: [0.42, 0.14],
    returnRate: [0.06, 0.04],
    rank: [0.2, 0.45, 0.3, 0.05],
    category: [0.3, 0.3, 0.1, 0.1, 0.1, 0.1],
    channel: [0.25, 0.25, 0.25, 0.15, 0.1],
  },
  {
    name: 'ディスカウント狙い',
    share: 0.22,
    age: [41, 12],
    orders: [14, 7],
    logAmount: [10.9, 0.6],
    recencyDays: [38, 22],
    openRate: [0.55, 0.15],
    appDays: [12, 6],
    couponRate: [0.82, 0.12],
    returnRate: [0.12, 0.06],
    rank: [0.35, 0.4, 0.2, 0.05],
    category: [0.2, 0.15, 0.4, 0.1, 0.1, 0.05],
    channel: [0.15, 0.2, 0.15, 0.45, 0.05],
  },
  {
    name: '新規',
    share: 0.26,
    age: [29, 7],
    orders: [2, 1.2],
    logAmount: [9.6, 0.6],
    recencyDays: [22, 18],
    openRate: [0.31, 0.16],
    appDays: [4, 3],
    couponRate: [0.5, 0.2],
    returnRate: [0.08, 0.05],
    rank: [0.7, 0.25, 0.05, 0],
    category: [0.25, 0.3, 0.15, 0.1, 0.1, 0.1],
    channel: [0.2, 0.4, 0.3, 0.05, 0.05],
  },
  {
    name: '休眠',
    share: 0.16,
    age: [52, 13],
    orders: [6, 4],
    logAmount: [10.4, 0.7],
    recencyDays: [280, 90],
    openRate: [0.11, 0.08],
    appDays: [1, 1.5],
    couponRate: [0.3, 0.2],
    returnRate: [0.07, 0.05],
    rank: [0.5, 0.35, 0.13, 0.02],
    category: [0.2, 0.15, 0.25, 0.2, 0.15, 0.05],
    channel: [0.4, 0.15, 0.1, 0.2, 0.15],
  },
];

function pick(weights: number[] | readonly number[], u: number): number {
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (u <= acc) return i;
  }
  return weights.length - 1;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export interface DemoOptions {
  seed?: number;
  /** 正解セグメントを列として含める（テスト・精度確認用） */
  includeTruth?: boolean;
}

/** CSV テキストを生成する */
export function generateDemoCsv(rows: number, options: DemoOptions = {}): string {
  const seed = options.seed ?? 7;
  const includeTruth = options.includeTruth ?? false;
  const rng = makeRng(seed);
  const gauss = makeGaussian(rng);
  const header = [
    '顧客ID',
    '年齢',
    '性別',
    '都道府県',
    '会員ランク',
    '初回購入日',
    '最終購入日',
    '購入回数',
    '累計購入金額',
    '平均単価',
    '返品率',
    'メール開封率',
    'アプリ起動日数',
    'クーポン利用率',
    '主要カテゴリ',
    '流入経路',
  ];
  if (includeTruth) header.push('真のセグメント');
  const parts: string[] = [header.join(',')];
  const today = Date.UTC(2026, 5, 30);
  const day = 86400000;

  const cumulative: number[] = [];
  let acc = 0;
  for (const s of SEGMENTS) {
    acc += s.share;
    cumulative.push(acc);
  }

  const buffer: string[] = [];
  for (let i = 0; i < rows; i++) {
    const u = rng();
    let segIdx = SEGMENTS.length - 1;
    for (let s = 0; s < cumulative.length; s++) {
      if (u <= cumulative[s]) {
        segIdx = s;
        break;
      }
    }
    const seg = SEGMENTS[segIdx];

    const age = Math.round(clamp(seg.age[0] + gauss() * seg.age[1], 18, 85));
    const orders = Math.max(1, Math.round(seg.orders[0] + gauss() * seg.orders[1]));
    const amount = Math.round(Math.exp(seg.logAmount[0] + gauss() * seg.logAmount[1]));
    const unit = Math.round(amount / orders);
    const recency = Math.max(0, Math.round(seg.recencyDays[0] + gauss() * seg.recencyDays[1]));
    const tenure = recency + Math.round(Math.abs(gauss()) * 200 + orders * 12);
    const openRate = clamp(seg.openRate[0] + gauss() * seg.openRate[1], 0, 1);
    const appDays = Math.max(0, Math.round(seg.appDays[0] + gauss() * seg.appDays[1]));
    const coupon = clamp(seg.couponRate[0] + gauss() * seg.couponRate[1], 0, 1);
    const ret = clamp(seg.returnRate[0] + gauss() * seg.returnRate[1], 0, 0.8);

    const lastDate = new Date(today - recency * day);
    const firstDate = new Date(today - tenure * day);
    const fmt = (d: Date) =>
      `${d.getUTCFullYear()}-${`${d.getUTCMonth() + 1}`.padStart(2, '0')}-${`${d.getUTCDate()}`.padStart(2, '0')}`;

    // 一部の列はわざと欠損させる（実データに近づける）
    const genderU = rng();
    const gender = genderU < 0.03 ? '' : GENDERS[pick([0.58, 0.38, 0.04], rng())];

    const record = [
        `C${(1000000 + i).toString()}`,
        age,
        gender,
        PREFS[pick([0.19, 0.11, 0.1, 0.08, 0.07, 0.07, 0.06, 0.06, 0.06, 0.05, 0.05, 0.1], rng())],
        RANKS[pick(seg.rank, rng())],
        fmt(firstDate),
        fmt(lastDate),
        orders,
        amount,
        unit,
        ret.toFixed(3),
        rng() < 0.05 ? '' : openRate.toFixed(3),
        appDays,
        coupon.toFixed(3),
        CATEGORIES[pick(seg.category, rng())],
        CHANNELS[pick(seg.channel, rng())],
    ];
    if (includeTruth) record.push(seg.name);
    buffer.push(record.join(','));

    if (buffer.length >= 5000) {
      parts.push(buffer.join('\n'));
      buffer.length = 0;
    }
  }
  if (buffer.length > 0) parts.push(buffer.join('\n'));
  return parts.join('\n') + '\n';
}
