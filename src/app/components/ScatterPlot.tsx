import { useEffect, useRef, useState } from 'react';
import type { ClusterResult } from '../../core/types.ts';
import { clusterColor } from '../palette.ts';

interface Props {
  result: ClusterResult;
}

/**
 * 主成分 2 軸への散布図。
 * 数万点を描くので SVG ではなく Canvas を使い、点は間引き済みのものを受け取る。
 */
export function ScatterPlot({ result }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hidden, setHidden] = useState<Set<number>>(new Set());

  useEffect(() => {
    setHidden(new Set());
  }, [result]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = parent.clientWidth;
      const height = Math.max(280, Math.min(460, Math.round(width * 0.55)));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const { x, y, label } = result.scatter;
      const n = x.length;
      if (n === 0) return;

      // 外れ値で潰れないよう 1〜99 パーセンタイルで範囲を決める
      const range = (values: Float32Array): [number, number] => {
        const sorted = Float32Array.from(values).sort();
        const lo = sorted[Math.floor(sorted.length * 0.005)];
        const hi = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.995))];
        const pad = (hi - lo) * 0.06 || 1;
        return [lo - pad, hi + pad];
      };
      const [x0, x1] = range(x);
      const [y0, y1] = range(y);
      const pad = 12;
      const sx = (v: number) => pad + ((v - x0) / (x1 - x0 || 1)) * (width - pad * 2);
      const sy = (v: number) => height - pad - ((v - y0) / (y1 - y0 || 1)) * (height - pad * 2);

      // 原点の補助線
      const style = getComputedStyle(document.documentElement);
      ctx.strokeStyle = style.getPropertyValue('--border').trim() || '#ddd';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad, sy(0));
      ctx.lineTo(width - pad, sy(0));
      ctx.moveTo(sx(0), pad);
      ctx.lineTo(sx(0), height - pad);
      ctx.stroke();

      const radius = n > 12000 ? 1.1 : n > 4000 ? 1.6 : 2.4;
      const alpha = n > 12000 ? 0.4 : n > 4000 ? 0.55 : 0.75;

      // クラスタごとにまとめて描くと fillStyle の切り替えが減って速い
      const byCluster = new Map<number, number[]>();
      for (let i = 0; i < n; i++) {
        const c = label[i];
        if (hidden.has(c)) continue;
        let list = byCluster.get(c);
        if (!list) {
          list = [];
          byCluster.set(c, list);
        }
        list.push(i);
      }

      ctx.globalAlpha = alpha;
      for (const [cluster, indices] of byCluster) {
        ctx.fillStyle = clusterColor(cluster);
        ctx.beginPath();
        for (const i of indices) {
          const px = sx(x[i]);
          const py = sy(y[i]);
          ctx.moveTo(px + radius, py);
          ctx.arc(px, py, radius, 0, Math.PI * 2);
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [result, hidden]);

  const [xDrivers, yDrivers] = result.scatter.axisDrivers;
  const [xExplained, yExplained] = result.scatter.explained;

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3>セグメントの分布</h3>
          <p className="section-hint">
            全特徴量を主成分 2 軸に圧縮した図です（{result.scatter.x.length.toLocaleString()} 点を表示）。
            近い点ほど似た顧客です。
          </p>
        </div>
      </div>
      <div className="card-body">
        <div className="scatter-wrap">
          <canvas ref={canvasRef} className="scatter-canvas" />
        </div>
        <div className="axis-label">
          <span>
            横軸 第1主成分（寄与率 {(xExplained * 100).toFixed(1)}%）
            {xDrivers.length > 0 && `: ${xDrivers.join(' , ')}`}
          </span>
          <span>
            縦軸 第2主成分（寄与率 {(yExplained * 100).toFixed(1)}%）
            {yDrivers.length > 0 && `: ${yDrivers.join(' , ')}`}
          </span>
        </div>
        <div className="legend">
          {result.clusters.map((cluster) => (
            <button
              key={cluster.id}
              aria-pressed={!hidden.has(cluster.id)}
              onClick={() => {
                setHidden((prev) => {
                  const next = new Set(prev);
                  if (next.has(cluster.id)) next.delete(cluster.id);
                  else next.add(cluster.id);
                  return next;
                });
              }}
            >
              <span
                className="swatch"
                style={{ background: clusterColor(cluster.id), marginRight: 0 }}
              />
              {cluster.id + 1}. {cluster.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
