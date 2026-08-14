import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEngine, phaseLabel } from './useEngine.ts';
import { DropZone } from './components/DropZone.tsx';
import { ColumnTable } from './components/ColumnTable.tsx';
import { SettingsPanel } from './components/SettingsPanel.tsx';
import { ClusterCards } from './components/ClusterCards.tsx';
import { ScatterPlot } from './components/ScatterPlot.tsx';
import { KChart } from './components/KChart.tsx';
import { ProfileTable } from './components/ProfileTable.tsx';
import { PreviewTable } from './components/PreviewTable.tsx';
import { Overview } from './components/Overview.tsx';
import { isNumericKind } from '../core/infer.ts';
import type { ExportKind } from '../core/types.ts';

type Tab = 'result' | 'columns' | 'preview';

function formatBytes(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)}GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)}MB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(0)}KB`;
  return `${bytes}B`;
}

export function App() {
  const engine = useEngine();
  const { state, options, setOptions, busy } = engine;
  const [tab, setTab] = useState<Tab>('columns');
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!state.result) return;
    setTab('result');
    // 縦積みレイアウト（スマホ・タブレット）では結果が設定パネルの下に来て
    // 画面外になるため、結果までスクロールする
    if (window.innerWidth <= 1000) {
      mainRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [state.result]);

  useEffect(() => {
    if (state.meta && !state.result) setTab('columns');
  }, [state.meta, state.result]);

  const featureCount = state.specs.filter((s) => s.role === 'feature').length;

  /** 保持するデータ量のざっくり見積もり（列指向ストアのバイト数） */
  const estimatedMemoryMb = useMemo(() => {
    const rows =
      options.maxRows > 0
        ? Math.min(options.maxRows, state.meta?.estimatedRows ?? 0)
        : (state.meta?.estimatedRows ?? 0);
    let bytesPerRow = 0;
    for (const spec of state.specs) {
      if (spec.role === 'ignore') continue;
      bytesPerRow += isNumericKind(spec.kind) ? 8 : 4;
    }
    return (rows * bytesPerRow) / (1024 * 1024);
  }, [state.specs, state.meta, options.maxRows]);

  const handleRun = useCallback(() => {
    engine.run(state.specs, options);
  }, [engine, state.specs, options]);

  const handleExport = useCallback(
    (kind: ExportKind) => {
      engine.exportFile(kind);
    },
    [engine],
  );

  const handlePickK = useCallback(
    (k: number) => {
      const next = { ...options, k };
      setOptions(() => next);
      engine.run(state.specs, next);
    },
    [engine, options, setOptions, state.specs],
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
            <circle cx="9" cy="11" r="4.5" fill="#3b62f6" />
            <circle cx="23" cy="9" r="3.5" fill="#0f9d76" />
            <circle cx="19" cy="23" r="5.5" fill="#f5871f" />
          </svg>
          <span className="brand-text">
            <b>AIクラスタリング</b>
            <small>CSV を投げるだけでセグメント分け</small>
          </span>
        </div>

        {/* 狭い画面では別行に回り込む（CSS の order で並べ替え） */}
        <span className="privacy-badge">
          <span aria-hidden="true">🔒</span> データは端末内で処理
        </span>

        {state.meta && (
          <div className="topbar-file">
            <strong title={state.meta.name}>{state.meta.name}</strong>
            <span className="file-meta">
              {formatBytes(state.meta.size)} / 約{state.meta.estimatedRows.toLocaleString()}行
            </span>
            <span className="file-meta file-meta-extra">
              {state.meta.encoding.toUpperCase()} /{' '}
              {state.meta.delimiter === '\t' ? 'タブ区切り' : `「${state.meta.delimiter}」区切り`}
            </span>
            <button className="btn btn-ghost btn-sm" onClick={engine.reset} disabled={busy}>
              別のファイル
            </button>
          </div>
        )}
      </header>

      {!state.meta ? (
        <>
          {state.error && (
            <div style={{ maxWidth: 780, margin: '20px auto 0', padding: '0 20px' }}>
              <div className="notice error">{state.error}</div>
            </div>
          )}
          <DropZone onFile={engine.loadFile} onDemo={engine.loadDemo} busy={busy} />
        </>
      ) : (
        <div className="layout">
          <aside className="sidebar">
            <SettingsPanel
              state={state}
              options={options}
              setOptions={setOptions}
              onRun={handleRun}
              onExport={handleExport}
              busy={busy}
              featureCount={featureCount}
              estimatedMemoryMb={estimatedMemoryMb}
            />
          </aside>

          <main className="main" ref={mainRef}>
            {state.error && <div className="notice error">{state.error}</div>}
            {state.warnings.length > 0 && (
              <div className="notice warn">
                <ul>
                  {state.warnings.map((warning, i) => (
                    <li key={i}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="tabs" role="tablist">
              <button
                role="tab"
                aria-selected={tab === 'result'}
                onClick={() => setTab('result')}
                disabled={!state.result}
              >
                結果
              </button>
              <button role="tab" aria-selected={tab === 'columns'} onClick={() => setTab('columns')}>
                列の設定（{featureCount}/{state.specs.length}）
              </button>
              <button role="tab" aria-selected={tab === 'preview'} onClick={() => setTab('preview')}>
                プレビュー
              </button>
            </div>

            {tab === 'result' &&
              (state.result ? (
                <>
                  <Overview result={state.result} rowCount={state.rowCount} />
                  <ClusterCards result={state.result} />
                  <ScatterPlot result={state.result} />
                  <KChart
                    scores={state.result.kScores}
                    chosen={state.result.k}
                    automatic={state.result.chosenAutomatically}
                    onPick={handlePickK}
                  />
                  <ProfileTable result={state.result} />
                </>
              ) : (
                <div className="card">
                  <div className="empty">
                    {busy ? phaseLabel(state.phase) : 'まだ結果がありません。'}
                  </div>
                </div>
              ))}

            {tab === 'columns' && (
              <ColumnTable
                specs={state.specs}
                onChange={engine.updateSpec}
                onBulk={engine.setSpecs}
                disabled={busy}
              />
            )}

            {tab === 'preview' && (
              <PreviewTable header={state.previewHeader} rows={state.previewRows} />
            )}
          </main>
        </div>
      )}

      <footer className="footer">
        AIクラスタリング — すべての計算はブラウザ内（Web Worker）で行われ、データが外部へ送信されることはありません。
      </footer>
    </div>
  );
}
