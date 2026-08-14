import type { KScore } from '../../core/types.ts';

interface Props {
  scores: KScore[];
  chosen: number;
  automatic: boolean;
  onPick: (k: number) => void;
}

const SIL_COLOR = '#3b62f6';
const INERTIA_COLOR = '#f5871f';

/**
 * クラスタ数ごとの評価。
 * シルエット係数（高いほど良い）と慣性（エルボーを探す）を重ねて表示する。
 */
export function KChart({ scores, chosen, automatic, onPick }: Props) {
  if (scores.length < 2) return null;

  const width = 560;
  const height = 170;
  const padL = 34;
  const padR = 34;
  const padT = 12;
  const padB = 26;

  const ks = scores.map((s) => s.k);
  const kMin = Math.min(...ks);
  const kMax = Math.max(...ks);
  const sils = scores.map((s) => s.silhouette);
  const silMin = Math.min(...sils, 0);
  const silMax = Math.max(...sils, 0.05);
  const inertias = scores.map((s) => s.inertia);
  const inMin = Math.min(...inertias);
  const inMax = Math.max(...inertias);

  const x = (k: number) =>
    padL + ((k - kMin) / (kMax - kMin || 1)) * (width - padL - padR);
  const ySil = (v: number) =>
    height - padB - ((v - silMin) / (silMax - silMin || 1)) * (height - padT - padB);
  const yIn = (v: number) =>
    height - padB - ((v - inMin) / (inMax - inMin || 1)) * (height - padT - padB);

  const line = (accessor: (s: KScore) => number, scale: (v: number) => number) =>
    scores.map((s, i) => `${i === 0 ? 'M' : 'L'}${x(s.k).toFixed(1)},${scale(accessor(s)).toFixed(1)}`).join(' ');

  const step = (width - padL - padR) / Math.max(1, kMax - kMin) / 2;

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>クラスタ数の評価</h3>
          <p className="section-hint">
            {automatic
              ? `シルエット係数とエルボーの両方から k=${chosen} を選びました。`
              : `k=${chosen} を手動指定しています。`}
            グラフをクリックすると、その k で再計算できます。
          </p>
        </div>
      </div>
      <div className="card-body">
        <svg className="kchart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
          <rect
            className="pick"
            x={x(chosen) - step}
            y={padT - 4}
            width={step * 2}
            height={height - padT - padB + 8}
            rx="4"
          />
          <line className="grid" x1={padL} y1={height - padB} x2={width - padR} y2={height - padB} />

          <path d={line((s) => s.inertia, yIn)} fill="none" stroke={INERTIA_COLOR} strokeWidth="2" strokeDasharray="4 3" />
          <path d={line((s) => s.silhouette, ySil)} fill="none" stroke={SIL_COLOR} strokeWidth="2.5" />

          {scores.map((s) => (
            <g key={s.k}>
              <circle cx={x(s.k)} cy={yIn(s.inertia)} r="2.5" fill={INERTIA_COLOR} />
              <circle
                cx={x(s.k)}
                cy={ySil(s.silhouette)}
                r={s.k === chosen ? 4.5 : 3}
                fill={SIL_COLOR}
                stroke="var(--surface)"
                strokeWidth={s.k === chosen ? 2 : 0}
              />
              <text x={x(s.k)} y={height - padB + 14} textAnchor="middle">
                {s.k}
              </text>
              <rect
                x={x(s.k) - step}
                y={padT - 4}
                width={step * 2}
                height={height - padT - padB + 8}
                fill="transparent"
                style={{ cursor: 'pointer' }}
                onClick={() => onPick(s.k)}
              >
                <title>
                  k={s.k} / シルエット {s.silhouette.toFixed(3)} / CH{' '}
                  {s.calinskiHarabasz.toFixed(0)} / DB {s.daviesBouldin.toFixed(2)}
                </title>
              </rect>
            </g>
          ))}

          <text x={padL - 6} y={padT + 6} textAnchor="end">
            {silMax.toFixed(2)}
          </text>
          <text x={padL - 6} y={height - padB} textAnchor="end">
            {silMin.toFixed(2)}
          </text>
          <text x={width - padR + 6} y={padT + 6}>
            高
          </text>
          <text x={width - padR + 6} y={height - padB}>
            低
          </text>
        </svg>
        <div className="chart-legend">
          <span>
            <i style={{ background: SIL_COLOR }} />
            シルエット係数（高いほど分離が良い）
          </span>
          <span>
            <i
              style={{
                background: `repeating-linear-gradient(90deg, ${INERTIA_COLOR} 0 4px, transparent 4px 7px)`,
              }}
            />
            クラスタ内の散らばり（折れ点＝エルボー）
          </span>
        </div>
      </div>
    </div>
  );
}
