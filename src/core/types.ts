/**
 * SegmentLab のコア型定義。
 * ここに置くモジュールはすべて DOM 非依存（Worker / Node どちらでも動く）。
 */

/** 列の推定データ型 */
export type ColumnKind =
  | 'numeric' // 連続値
  | 'categorical' // カテゴリ（低〜中カーディナリティ）
  | 'boolean' // 2値
  | 'datetime' // 日付・日時
  | 'text' // 自由記述（特徴量にしない）
  | 'identifier' // ID・ほぼ一意な文字列（特徴量にしない）
  | 'constant' // 単一値のみ（情報量ゼロ）
  | 'empty'; // ほぼ全部欠損

/** 列の使い道 */
export type ColumnRole =
  | 'feature' // クラスタリングに使う
  | 'profile' // クラスタリングには使わないが、プロファイル（解釈）には使う
  | 'ignore'; // 読み込まない

/** 数値列の変換方法 */
export type NumericTransform =
  | 'auto' // 歪度を見て log1p / robust / standard を自動選択
  | 'standard' // (x - mean) / sd
  | 'robust' // (x - median) / IQR
  | 'log' // log1p してから standard（非負のみ）
  | 'quantile' // 分位点 → 正規分布に写像（外れ値に最も強い）
  | 'minmax'; // 0-1

/** 1 列ぶんの推定結果とユーザー設定 */
export interface ColumnSpec {
  index: number;
  name: string;
  kind: ColumnKind;
  /** 推定された元の型（ユーザーが kind を上書きしても残す） */
  inferredKind: ColumnKind;
  role: ColumnRole;
  transform: NumericTransform;
  /** この列をどれだけ重視するか（1 が標準）。マーケ的に重要な指標を強められる */
  weight: number;
  /** サンプル中の非欠損率 0-1 */
  fillRate: number;
  /** サンプル中のユニーク数（頭打ちあり） */
  distinctCount: number;
  /** 推定の根拠を人間向けに一言で */
  note: string;
  /** プレビュー用のサンプル値 */
  sampleValues: string[];
}

/** 列ごとの統計量（全件パース後に算出） */
export interface NumericStats {
  count: number;
  missing: number;
  mean: number;
  sd: number;
  min: number;
  max: number;
  p01: number;
  p25: number;
  median: number;
  p75: number;
  p99: number;
  skewness: number;
}

export interface CategoryStats {
  count: number;
  missing: number;
  /** 出現頻度降順のカテゴリ（上位のみ） */
  levels: { value: string; count: number }[];
  distinct: number;
}

/** 全件読み込み後の列データ（列指向 = 数十万行でもメモリ効率が良い） */
export type ColumnData =
  | {
      kind: 'numeric';
      spec: ColumnSpec;
      values: Float64Array;
      /** NaN は欠損 */
      stats: NumericStats;
    }
  | {
      kind: 'categorical';
      spec: ColumnSpec;
      /** 辞書へのインデックス。-1 は欠損 */
      codes: Int32Array;
      dictionary: string[];
      stats: CategoryStats;
    };

export interface Dataset {
  rowCount: number;
  columns: ColumnData[];
  /** UI プレビュー用の生データ（先頭数十行） */
  previewRows: string[][];
  previewHeader: string[];
  /** 読み込み時に発生した警告 */
  warnings: string[];
  /** 元ファイルの総行数（サンプリングした場合は rowCount より大きい） */
  sourceRowCount: number;
  /** 間引き読み込みの間隔（1 なら全件） */
  sampleStride: number;
}

/** 特徴量エンコード後の 1 次元の説明 */
export interface FeatureMeta {
  /** 由来する列名 */
  column: string;
  /** 表示用のラベル（"年齢" や "職業 = 会社員" など） */
  label: string;
  columnIndex: number;
  type: 'numeric' | 'onehot';
  /** onehot の場合の水準 */
  level?: string;
}

export type AlgorithmId = 'kmeans' | 'ward';

export interface RunOptions {
  /** null なら自動決定 */
  k: number | null;
  kMin: number;
  kMax: number;
  algorithm: AlgorithmId;
  seed: number;
  /** 自動決定に使うサンプル行数 */
  autoKSampleSize: number;
  /** PCA を通す閾値。エンコード後の次元がこれを超えたら次元圧縮する */
  pcaThreshold: number;
  pcaComponents: number;
  /** 極端な外れ値をクラスタリング前に丸めるか */
  winsorize: boolean;
  /** 読み込む最大行数（0 なら全件）。巨大ファイル向けの間引き読み込み */
  maxRows: number;
}

export const DEFAULT_RUN_OPTIONS: RunOptions = {
  k: null,
  kMin: 2,
  kMax: 10,
  algorithm: 'kmeans',
  seed: 42,
  autoKSampleSize: 15000,
  pcaThreshold: 60,
  pcaComponents: 50,
  winsorize: true,
  maxRows: 0,
};

/** k ごとの評価指標 */
export interface KScore {
  k: number;
  inertia: number;
  silhouette: number;
  calinskiHarabasz: number;
  daviesBouldin: number;
}

/** 数値列のクラスタ別プロファイル */
export interface NumericProfile {
  column: string;
  kind: 'numeric';
  /** 表示の書式を決めるための元の列種別（日付なら日付として出す） */
  valueKind: ColumnKind;
  overallMean: number;
  overallMedian: number;
  clusters: {
    mean: number;
    median: number;
    /** 全体平均からの標準化差分（効果量）。解釈の主役 */
    z: number;
    /** 全体平均比（1.0 = 平均並み） */
    ratio: number;
  }[];
  /** クラスタ間の分離度（eta^2, 0-1） */
  separation: number;
}

/** カテゴリ列のクラスタ別プロファイル */
export interface CategoricalProfile {
  column: string;
  kind: 'categorical';
  levels: string[];
  overallShare: number[];
  clusters: {
    /** levels と同じ並びのシェア */
    share: number[];
    /** シェア / 全体シェア（リフト） */
    lift: number[];
  }[];
  /** クラスタ間の分離度（Cramer's V, 0-1） */
  separation: number;
}

export type ColumnProfile = NumericProfile | CategoricalProfile;

/** クラスタの「特徴」1 件 */
export interface Highlight {
  column: string;
  /** 表示用テキスト（"平均購入額 が 2.4 倍"） */
  text: string;
  /** 効果量の絶対値。並べ替え用 */
  strength: number;
  direction: 'high' | 'low' | 'category';
  value: string;
}

export interface ClusterSummary {
  id: number;
  size: number;
  share: number;
  /** 自動生成した名前 */
  name: string;
  highlights: Highlight[];
  /** クラスタ中心に最も近い代表行のインデックス */
  representativeRows: number[];
}

export interface ClusterResult {
  k: number;
  labels: Int32Array;
  sizes: number[];
  clusters: ClusterSummary[];
  profiles: ColumnProfile[];
  kScores: KScore[];
  chosenAutomatically: boolean;
  /** 散布図用の 2 次元座標（間引き済み） */
  scatter: {
    x: Float32Array;
    y: Float32Array;
    label: Int32Array;
    /** 元データの行番号 */
    rowIndex: Int32Array;
    /** 主成分の寄与率 */
    explained: [number, number];
    /** 各主成分に効いている列（上位） */
    axisDrivers: [string[], string[]];
  };
  /** 特徴量空間の情報 */
  featureCount: number;
  usedColumns: string[];
  reducedDim: number;
  /** 全体の分離度指標 */
  silhouette: number;
  elapsedMs: number;
  /** クラスタリングに使った有効行数（全欠損行を除く） */
  effectiveRows: number;
}

export type ExportKind = 'labeled-csv' | 'profile-csv' | 'summary-md';

/** Worker との通信メッセージ */
export type WorkerRequest =
  | { type: 'load-file'; file: File; requestId: number }
  | { type: 'load-demo'; rows: number; requestId: number }
  | { type: 'run'; specs: ColumnSpec[]; options: RunOptions; requestId: number }
  | { type: 'export'; kind: ExportKind; requestId: number };

export type WorkerResponse =
  | { type: 'progress'; phase: string; detail?: string; ratio: number; requestId: number }
  | {
      type: 'inspected';
      specs: ColumnSpec[];
      previewRows: string[][];
      previewHeader: string[];
      estimatedRows: number;
      fileName: string;
      fileSize: number;
      encoding: string;
      delimiter: string;
      warnings: string[];
      requestId: number;
    }
  | {
      type: 'result';
      result: ClusterResult;
      rowCount: number;
      warnings: string[];
      requestId: number;
    }
  | { type: 'exported'; blob: Blob; fileName: string; requestId: number }
  | { type: 'error'; message: string; requestId: number };
