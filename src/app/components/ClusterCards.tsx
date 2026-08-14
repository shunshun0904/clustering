import type { ClusterResult } from '../../core/types.ts';
import { formatCount, formatPercent } from '../../core/format.ts';
import { clusterColor } from '../palette.ts';

interface Props {
  result: ClusterResult;
}

const ARROW: Record<string, string> = { high: '↑', low: '↓', category: '●' };

export function ClusterCards({ result }: Props) {
  const maxShare = Math.max(...result.clusters.map((c) => c.share), 0.01);

  return (
    <div className="cluster-grid">
      {result.clusters.map((cluster) => (
        <article
          key={cluster.id}
          className="cluster-card"
          style={{ ['--cluster-color' as string]: clusterColor(cluster.id) }}
        >
          <header>
            <span className="cluster-name">
              {cluster.id + 1}. {cluster.name}
            </span>
            <span className="cluster-size">
              {formatCount(cluster.size)}件 / {formatPercent(cluster.share, 1)}
            </span>
          </header>
          <div className="cluster-bar">
            <div style={{ width: `${(cluster.share / maxShare) * 100}%` }} />
          </div>
          <ul className="highlight-list">
            {cluster.highlights.length === 0 && (
              <li style={{ color: 'var(--faint)' }}>全体平均と大きな差はありません</li>
            )}
            {cluster.highlights.map((highlight, i) => (
              <li key={`${highlight.column}-${i}`}>
                <span className={`arrow ${highlight.direction}`} aria-hidden="true">
                  {ARROW[highlight.direction]}
                </span>
                <span>{highlight.text}</span>
              </li>
            ))}
          </ul>
        </article>
      ))}
    </div>
  );
}
