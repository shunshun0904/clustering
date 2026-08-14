/**
 * 規模ごとの処理時間を測るベンチマーク。
 *   node --experimental-strip-types scripts/bench.ts [rows] [wideCols]
 */
import { inspectSource, loadDataset } from '../src/core/loader.ts';
import { StringTextSource } from '../src/core/source.ts';
import { runPipeline } from '../src/core/pipeline.ts';
import { generateDemoCsv } from '../src/core/demo.ts';
import { DEFAULT_RUN_OPTIONS } from '../src/core/types.ts';
import { makeGaussian, makeRng } from '../src/core/rng.ts';

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)}MB`;
}

function heap(): string {
  return mb(process.memoryUsage().heapUsed);
}

async function benchDemo(rows: number) {
  console.log(`\n=== 顧客データ ${rows.toLocaleString()} 行 × 16 列 ===`);
  let t = Date.now();
  const csv = generateDemoCsv(rows, { seed: 7 });
  console.log(`  生成          ${Date.now() - t}ms (${mb(csv.length * 2)} の文字列)`);

  const source = new StringTextSource('demo.csv', csv);
  t = Date.now();
  const inspect = await inspectSource(source);
  console.log(`  列推定        ${Date.now() - t}ms  推定行数=${inspect.estimatedRows.toLocaleString()}`);

  t = Date.now();
  const dataset = await loadDataset(source, inspect.specs, {
    delimiter: inspect.delimiter,
    estimatedRows: inspect.estimatedRows,
  });
  console.log(`  全件読込      ${Date.now() - t}ms  ${dataset.rowCount.toLocaleString()} 行 / heap ${heap()}`);

  t = Date.now();
  const result = runPipeline({ dataset, options: { ...DEFAULT_RUN_OPTIONS, k: null } });
  console.log(`  クラスタリング ${Date.now() - t}ms  k=${result.k} dim=${result.featureCount}→${result.reducedDim} silhouette=${result.silhouette.toFixed(3)}`);
  console.log(`  合計 heap ${heap()}`);
  console.log(
    '  セグメント: ' +
      result.clusters.map((c) => `${c.name}(${(c.share * 100).toFixed(0)}%)`).join(', '),
  );
}

async function benchWide(rows: number, cols: number) {
  console.log(`\n=== 数値のみ ${rows.toLocaleString()} 行 × ${cols} 列 ===`);
  const rng = makeRng(3);
  const gauss = makeGaussian(rng);
  const groups = 6;
  const centers = Array.from({ length: groups }, () =>
    Array.from({ length: cols }, () => gauss() * 3),
  );
  let t = Date.now();
  const header: string[] = [];
  for (let c = 0; c < cols; c++) header.push(`f${c}`);
  const parts = [header.join(',')];
  const buf: string[] = [];
  for (let r = 0; r < rows; r++) {
    const g = r % groups;
    const values = new Array<string>(cols);
    for (let c = 0; c < cols; c++) values[c] = (centers[g][c] + gauss()).toFixed(3);
    buf.push(values.join(','));
    if (buf.length >= 5000) {
      parts.push(buf.join('\n'));
      buf.length = 0;
    }
  }
  if (buf.length) parts.push(buf.join('\n'));
  const csv = parts.join('\n');
  console.log(`  生成          ${Date.now() - t}ms (${mb(csv.length * 2)})`);

  const source = new StringTextSource('wide.csv', csv);
  t = Date.now();
  const inspect = await inspectSource(source);
  console.log(`  列推定        ${Date.now() - t}ms`);

  t = Date.now();
  const dataset = await loadDataset(source, inspect.specs, {
    delimiter: inspect.delimiter,
    estimatedRows: inspect.estimatedRows,
  });
  console.log(`  全件読込      ${Date.now() - t}ms / heap ${heap()}`);

  t = Date.now();
  const result = runPipeline({ dataset, options: { ...DEFAULT_RUN_OPTIONS, k: null } });
  console.log(
    `  クラスタリング ${Date.now() - t}ms  k=${result.k} dim=${result.featureCount}→${result.reducedDim} silhouette=${result.silhouette.toFixed(3)}`,
  );
  console.log(`  合計 heap ${heap()}`);
}

const rows = Number(process.argv[2] ?? 300000);
const wideCols = Number(process.argv[3] ?? 300);
await benchDemo(rows);
await benchWide(Math.min(rows, 100000), wideCols);
