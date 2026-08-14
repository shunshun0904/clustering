import { useCallback, useRef, useState } from 'react';

interface Props {
  onFile: (file: File) => void;
  onDemo: (rows: number) => void;
  busy: boolean;
}

const ACCEPT = '.csv,.tsv,.txt,.xlsx,.xls,.xlsm,text/csv,text/tab-separated-values';

export function DropZone({ onFile, onDemo, busy }: Props) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files?.[0];
      if (file) onFile(file);
    },
    [onFile],
  );

  return (
    <div className="hero">
      <h1>テーブルデータを、よしなにクラスタリング</h1>
      <p>
        CSV / TSV / Excel を置くだけで、列の型を自動判定し、前処理からクラスタ数の決定、
        セグメントの解釈までを一気に行います。データはブラウザの中だけで処理され、
        どこにも送信されません。
      </p>

      <div
        className={`dropzone${dragging ? ' dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
        }}
      >
        <div className="dropzone-icon" aria-hidden="true">
          ⬚
        </div>
        <strong>{busy ? '読み込み中…' : 'ファイルをドロップ、またはクリックして選択'}</strong>
        <span>CSV / TSV / Excel（.xlsx）・UTF-8 / Shift_JIS 自動判定</span>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFile(file);
            e.target.value = '';
          }}
        />
      </div>

      <div className="hero-actions">
        <button className="btn" onClick={() => onDemo(20000)} disabled={busy}>
          デモデータで試す（EC顧客 2万件）
        </button>
        <button className="btn btn-ghost" onClick={() => onDemo(200000)} disabled={busy}>
          20万件で試す
        </button>
      </div>

      <div className="feature-grid">
        <div>
          <h3>前処理は自動</h3>
          <p>
            数値・カテゴリ・日付・ID・自由記述を推定し、歪んだ分布は対数／分位点変換、
            カテゴリはワンホット化。列ごとの影響度が揃うよう正規化します。
          </p>
        </div>
        <div>
          <h3>セグメント数も自動</h3>
          <p>
            シルエット係数とエルボー法を組み合わせて決定。極端に小さいセグメントは避け、
            解釈しやすい数に寄せます。もちろん手動指定も可能。
          </p>
        </div>
        <div>
          <h3>解釈まで出す</h3>
          <p>
            全体平均との差（効果量）と構成比リフトから各セグメントの特徴を抽出し、
            自動で名前を付けます。CSV とレポートで書き出せます。
          </p>
        </div>
        <div>
          <h3>数十万行でも動く</h3>
          <p>
            列指向ストア・ミニバッチ k-means・ランダム化 PCA で、
            数十万行 × 数百列でも Web Worker 上で完結します。
          </p>
        </div>
      </div>
    </div>
  );
}
