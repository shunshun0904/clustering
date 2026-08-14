import { useMemo, useState } from 'react';
import type { ClusterResult, ColumnProfile } from '../../core/types.ts';
import { formatByKind, formatPercent } from '../../core/format.ts';
import { clusterColor, heatColor, liftColor } from '../palette.ts';

interface Props {
  result: ClusterResult;
}

type SortMode = 'separation' | 'original';

/**
 * クラスタ × 列のクロス集計。
 * 数値は平均値と効果量、カテゴリは構成比とリフトを色で示す。
 */
export function ProfileTable({ result }: Props) {
  const [sort, setSort] = useState<SortMode>('separation');
  const [showAll, setShowAll] = useState(false);

  const profiles = useMemo(() => {
    const list = [...result.profiles];
    if (sort === 'separation') list.sort((a, b) => b.separation - a.separation);
    return list;
  }, [result.profiles, sort]);

  const visible = showAll ? profiles : profiles.slice(0, 12);
  const clusters = result.clusters;

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>列ごとのセグメント比較</h3>
          <p className="section-hint">
            背景色は全体平均との差の大きさです。
            <span style={{ color: '#3b62f6', fontWeight: 600 }}>青</span> が平均より高く、
            <span style={{ color: '#f5871f', fontWeight: 600 }}>橙</span> が低いことを表します。
            「分離度」はその列がセグメントをどれだけ説明しているか（0〜1）。
          </p>
        </div>
        <div className="segmented" style={{ flex: 'none' }}>
          <button aria-pressed={sort === 'separation'} onClick={() => setSort('separation')}>
            効く順
          </button>
          <button aria-pressed={sort === 'original'} onClick={() => setSort('original')}>
            元の順
          </button>
        </div>
      </div>

      <div className="table-wrap" style={{ border: 'none', maxHeight: 640, overflowY: 'auto' }}>
        <table className="zebra">
          <thead>
            <tr>
              <th className="sticky-col">列 / 水準</th>
              <th className="num">分離度</th>
              <th className="num">全体</th>
              {clusters.map((cluster) => (
                <th key={cluster.id} className="num" title={cluster.name}>
                  <span className="swatch" style={{ background: clusterColor(cluster.id) }} />
                  {cluster.id + 1}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((profile) => (
              <ProfileRows key={profile.column} profile={profile} />
            ))}
          </tbody>
        </table>
      </div>

      {profiles.length > 12 && (
        <div className="card-body" style={{ paddingTop: 10, paddingBottom: 10 }}>
          <button className="btn btn-sm" onClick={() => setShowAll((v) => !v)}>
            {showAll ? '上位 12 列だけ表示' : `残り ${profiles.length - 12} 列も表示`}
          </button>
        </div>
      )}
    </div>
  );
}

function ProfileRows({ profile }: { profile: ColumnProfile }) {
  if (profile.kind === 'numeric') {
    return (
      <tr>
        <td className="sticky-col" style={{ fontWeight: 600 }}>
          {profile.column}
        </td>
        <td className="num">{profile.separation.toFixed(2)}</td>
        <td className="num" style={{ color: 'var(--muted)' }}>
          {formatByKind(profile.valueKind, profile.overallMean)}
        </td>
        {profile.clusters.map((cluster, i) => (
          <td
            key={i}
            className="num"
            style={{ background: heatColor(cluster.z) }}
            title={`平均 ${formatByKind(profile.valueKind, cluster.mean)} / 中央値 ${formatByKind(
              profile.valueKind,
              cluster.median,
            )} / 効果量 z=${cluster.z.toFixed(2)}`}
          >
            {formatByKind(profile.valueKind, cluster.mean)}
          </td>
        ))}
      </tr>
    );
  }

  return (
    <>
      {profile.levels.map((level, s) => (
        <tr key={level}>
          <td className="sticky-col">
            {s === 0 ? (
              <strong>{profile.column}</strong>
            ) : (
              <span style={{ color: 'var(--faint)' }}>　</span>
            )}
            <span style={{ marginLeft: s === 0 ? 8 : 14, color: 'var(--muted)' }}>{level}</span>
          </td>
          <td className="num">{s === 0 ? profile.separation.toFixed(2) : ''}</td>
          <td className="num" style={{ color: 'var(--muted)' }}>
            {formatPercent(profile.overallShare[s])}
          </td>
          {profile.clusters.map((cluster, i) => (
            <td
              key={i}
              className="num"
              style={{ background: liftColor(cluster.lift[s]) }}
              title={`構成比 ${formatPercent(cluster.share[s])} / 全体比 ${cluster.lift[s].toFixed(2)}倍`}
            >
              {formatPercent(cluster.share[s], 0)}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
