import type { AlgorithmId, RunOptions } from '../../core/types.ts';
import type { EngineState } from '../useEngine.ts';
import { phaseLabel } from '../useEngine.ts';

interface Props {
  state: EngineState;
  options: RunOptions;
  setOptions: (updater: (prev: RunOptions) => RunOptions) => void;
  onRun: () => void;
  onExport: (kind: 'labeled-csv' | 'profile-csv' | 'summary-md') => void;
  busy: boolean;
  featureCount: number;
  estimatedMemoryMb: number;
}

const ALGORITHMS: { id: AlgorithmId; label: string; hint: string }[] = [
  {
    id: 'kmeans',
    label: 'k-means',
    hint: '大規模データ向け。丸い（等方的な）まとまりを高速に見つけます。',
  },
  {
    id: 'ward',
    label: 'Ward 法',
    hint: '階層的にまとめる方法。入れ子構造や大きさの違うまとまりに強い一方、やや低速です。',
  },
];

export function SettingsPanel({
  state,
  options,
  setOptions,
  onRun,
  onExport,
  busy,
  featureCount,
  estimatedMemoryMb,
}: Props) {
  const hasResult = state.result !== null;
  const rows = state.meta?.estimatedRows ?? 0;
  const heavy = estimatedMemoryMb > 700;

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>実行設定</h2>
        </div>
        <div className="card-body">
          <div className="field">
            <span className="field-label" id="k-mode-label">
              セグメント数
            </span>
            <div className="segmented" role="group" aria-labelledby="k-mode-label">
              <button
                aria-pressed={options.k === null}
                onClick={() => setOptions((prev) => ({ ...prev, k: null }))}
                disabled={busy}
              >
                自動
              </button>
              <button
                aria-pressed={options.k !== null}
                onClick={() =>
                  setOptions((prev) => ({ ...prev, k: prev.k ?? state.result?.k ?? 4 }))
                }
                disabled={busy}
              >
                指定する
              </button>
            </div>
            {options.k === null ? (
              <div className="inline-row">
                <input
                  type="number"
                  min={2}
                  max={30}
                  value={options.kMin}
                  disabled={busy}
                  aria-label="最小セグメント数"
                  onChange={(e) =>
                    setOptions((prev) => ({
                      ...prev,
                      kMin: Math.max(2, Math.min(30, Number(e.target.value) || 2)),
                    }))
                  }
                />
                <span style={{ color: 'var(--muted)' }}>〜</span>
                <input
                  type="number"
                  min={2}
                  max={30}
                  value={options.kMax}
                  disabled={busy}
                  aria-label="最大セグメント数"
                  onChange={(e) =>
                    setOptions((prev) => ({
                      ...prev,
                      kMax: Math.max(2, Math.min(30, Number(e.target.value) || 10)),
                    }))
                  }
                />
              </div>
            ) : (
              <input
                type="number"
                min={2}
                max={30}
                value={options.k}
                disabled={busy}
                aria-label="セグメント数"
                onChange={(e) =>
                  setOptions((prev) => ({
                    ...prev,
                    k: Math.max(2, Math.min(30, Number(e.target.value) || 2)),
                  }))
                }
              />
            )}
            <span className="hint">
              {options.k === null
                ? 'この範囲を全部試して、シルエット係数とエルボーから選びます。'
                : '指定した数で分割します（他の k の評価値も併せて表示します）。'}
            </span>
          </div>

          <div className="field">
            <label htmlFor="algorithm">手法</label>
            <select
              id="algorithm"
              value={options.algorithm}
              disabled={busy}
              onChange={(e) =>
                setOptions((prev) => ({ ...prev, algorithm: e.target.value as AlgorithmId }))
              }
            >
              {ALGORITHMS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
            <span className="hint">
              {ALGORITHMS.find((a) => a.id === options.algorithm)?.hint}
            </span>
          </div>

          <details>
            <summary style={{ cursor: 'pointer', fontSize: 12.5, color: 'var(--muted)' }}>
              詳細設定
            </summary>
            <div style={{ marginTop: 12 }}>
              <div className="field">
                <label htmlFor="max-rows">読み込む最大行数</label>
                <select
                  id="max-rows"
                  value={options.maxRows}
                  disabled={busy}
                  onChange={(e) =>
                    setOptions((prev) => ({ ...prev, maxRows: Number(e.target.value) }))
                  }
                >
                  <option value={0}>全件</option>
                  <option value={500000}>50万行まで</option>
                  <option value={200000}>20万行まで</option>
                  <option value={100000}>10万行まで</option>
                  <option value={50000}>5万行まで</option>
                </select>
                <span className="hint">
                  超える場合は等間隔に間引きます。巨大なファイルで動作が重いときに。
                </span>
              </div>

              <div className="field">
                <label htmlFor="seed">乱数シード</label>
                <input
                  id="seed"
                  type="number"
                  value={options.seed}
                  disabled={busy}
                  onChange={(e) =>
                    setOptions((prev) => ({ ...prev, seed: Number(e.target.value) || 0 }))
                  }
                />
                <span className="hint">同じシードなら毎回同じ結果になります。</span>
              </div>

              <div className="field">
                <label htmlFor="pca">次元圧縮の閾値</label>
                <input
                  id="pca"
                  type="number"
                  min={4}
                  max={500}
                  value={options.pcaThreshold}
                  disabled={busy}
                  onChange={(e) =>
                    setOptions((prev) => ({
                      ...prev,
                      pcaThreshold: Math.max(4, Number(e.target.value) || 60),
                    }))
                  }
                />
                <span className="hint">
                  特徴量がこの次元を超えたら主成分分析で {options.pcaComponents} 次元に圧縮します。
                </span>
              </div>
            </div>
          </details>

          <div className="divider" />

          <button
            className="btn btn-primary btn-block btn-lg"
            onClick={onRun}
            disabled={busy || featureCount === 0}
          >
            {busy && state.status === 'running' ? (
              <>
                <span className="spinner" /> 実行中…
              </>
            ) : hasResult ? (
              'この設定で再実行'
            ) : (
              'クラスタリングを実行'
            )}
          </button>
          {featureCount === 0 && (
            <p className="hint" style={{ marginTop: 8, color: 'var(--warn)' }}>
              特徴量に使う列が 1 つもありません。列設定で選んでください。
            </p>
          )}

          {busy && (
            <div style={{ marginTop: 12 }}>
              <div className="progress">
                <div style={{ width: `${Math.round(state.ratio * 100)}%` }} />
              </div>
              <div className="progress-text">
                <span>{state.detail || phaseLabel(state.phase)}</span>
                <span>{Math.round(state.ratio * 100)}%</span>
              </div>
            </div>
          )}

          {!busy && rows > 0 && (
            <p
              className="hint"
              style={{ marginTop: 10, color: heavy ? 'var(--warn)' : undefined }}
            >
              推定メモリ使用量{' '}
              {estimatedMemoryMb < 1 ? '1MB 未満' : `約 ${estimatedMemoryMb.toFixed(0)}MB`}
              {heavy && '。重い場合は列を減らすか、最大行数を設定してください。'}
            </p>
          )}
        </div>
      </div>

      {hasResult && (
        <div className="card">
          <div className="card-head">
            <h2>書き出し</h2>
          </div>
          <div className="card-body" style={{ display: 'grid', gap: 8 }}>
            <button
              className="btn btn-block"
              disabled={busy}
              onClick={() => onExport('labeled-csv')}
            >
              元データ + セグメント列（CSV）
            </button>
            <button
              className="btn btn-block"
              disabled={busy}
              onClick={() => onExport('profile-csv')}
            >
              セグメント別プロファイル（CSV）
            </button>
            <button
              className="btn btn-block"
              disabled={busy}
              onClick={() => onExport('summary-md')}
            >
              レポート（Markdown）
            </button>
          </div>
        </div>
      )}
    </>
  );
}
