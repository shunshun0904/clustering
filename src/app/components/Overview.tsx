import type { ClusterResult } from '../../core/types.ts';
import { formatCount } from '../../core/format.ts';

interface Props {
  result: ClusterResult;
  rowCount: number;
}

function quality(silhouette: number): { label: string; color: string } {
  if (silhouette >= 0.5) return { label: 'はっきり分かれている', color: 'var(--ok)' };
  if (silhouette >= 0.25) return { label: 'そこそこ分かれている', color: 'var(--ok)' };
  if (silhouette >= 0.1) return { label: '緩やかに分かれている', color: 'var(--warn)' };
  return { label: '重なりが大きい', color: 'var(--warn)' };
}

export function Overview({ result, rowCount }: Props) {
  const q = quality(result.silhouette);
  const seconds = (result.elapsedMs / 1000).toFixed(1);

  return (
    <dl className="stat-row">
      <div className="stat">
        <dt>対象データ</dt>
        <dd>
          {formatCount(rowCount)}
          <small>行 × {result.usedColumns.length}列</small>
        </dd>
      </div>
      <div className="stat">
        <dt>セグメント数</dt>
        <dd>
          {result.k}
          <small>{result.chosenAutomatically ? '自動決定' : '手動指定'}</small>
        </dd>
      </div>
      <div className="stat">
        <dt>分離の良さ（シルエット）</dt>
        <dd style={{ color: q.color }}>
          {result.silhouette.toFixed(3)}
          <small style={{ color: q.color }}>{q.label}</small>
        </dd>
      </div>
      <div className="stat">
        <dt>特徴量</dt>
        <dd>
          {result.featureCount}
          <small>
            次元{result.reducedDim < result.featureCount && ` → ${result.reducedDim}に圧縮`}
          </small>
        </dd>
      </div>
      <div className="stat">
        <dt>計算時間</dt>
        <dd>
          {seconds}
          <small>秒</small>
        </dd>
      </div>
    </dl>
  );
}
