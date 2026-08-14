import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { inspectSource, loadDataset } from '../src/core/loader.ts';
import { StringTextSource } from '../src/core/source.ts';
import { runPipeline } from '../src/core/pipeline.ts';
import { generateDemoCsv } from '../src/core/demo.ts';
import { buildProfileCsv, buildSummaryMarkdown, buildLabeledCsv } from '../src/core/export.ts';
import { DEFAULT_RUN_OPTIONS, type ColumnSpec, type Dataset } from '../src/core/types.ts';
import { adjustedRandIndex } from './helpers.ts';

async function loadDemo(rows: number, includeTruth = true) {
  const csv = generateDemoCsv(rows, { seed: 7, includeTruth });
  const source = new StringTextSource('demo.csv', csv);
  const inspect = await inspectSource(source);
  return { source, inspect, csv };
}

function withTruthIgnored(specs: ColumnSpec[]): ColumnSpec[] {
  return specs.map((s) =>
    s.name === '真のセグメント' ? { ...s, role: 'profile' as const } : s,
  );
}

function truthLabels(dataset: Dataset): Int32Array {
  const column = dataset.columns.find((c) => c.spec.name === '真のセグメント');
  assert.ok(column && column.kind === 'categorical');
  return column.kind === 'categorical' ? column.codes : new Int32Array(0);
}

test('デモデータの列を正しく推定する', async () => {
  const { inspect } = await loadDemo(3000);
  const byName = new Map(inspect.specs.map((s) => [s.name, s]));

  assert.equal(byName.get('顧客ID')!.kind, 'identifier');
  assert.equal(byName.get('顧客ID')!.role, 'ignore');
  assert.equal(byName.get('年齢')!.kind, 'numeric');
  assert.equal(byName.get('累計購入金額')!.kind, 'numeric');
  assert.equal(byName.get('会員ランク')!.kind, 'categorical');
  assert.equal(byName.get('最終購入日')!.kind, 'datetime');
  assert.equal(byName.get('都道府県')!.kind, 'categorical');
  // ファイル全体が推定用バッファに収まる場合は実数と一致する
  assert.equal(inspect.estimatedRows, 3000);
});

test('仕込んだ 5 セグメントを復元できる', async () => {
  const { source, inspect } = await loadDemo(8000);
  const specs = withTruthIgnored(inspect.specs);
  const dataset = await loadDataset(source, specs, {
    delimiter: inspect.delimiter,
    estimatedRows: inspect.estimatedRows,
  });
  assert.equal(dataset.rowCount, 8000);

  const result = runPipeline({
    dataset,
    options: { ...DEFAULT_RUN_OPTIONS, k: 5 },
  });

  assert.equal(result.k, 5);
  assert.equal(result.labels.length, 8000);
  const ari = adjustedRandIndex(result.labels, truthLabels(dataset));
  assert.ok(ari > 0.55, `正解セグメントとの一致度が低い: ARI=${ari.toFixed(3)}`);
  // 実データに近い重なりのあるセグメントなので、シルエットは高くならない。
  // 0.1 前後でも「正解を復元できている」ことは ARI 側で担保する。
  assert.ok(result.silhouette > 0.1, `シルエットが低すぎる: ${result.silhouette}`);

  // 全セグメントに名前と特徴が付いている
  for (const cluster of result.clusters) {
    assert.ok(cluster.size > 0);
    assert.ok(cluster.name.length > 0);
    assert.ok(cluster.highlights.length > 0, `${cluster.name} に特徴がない`);
  }
  const shareSum = result.clusters.reduce((a, c) => a + c.share, 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-6);
});

test('k を自動決定できる', async () => {
  const { source, inspect } = await loadDemo(6000);
  const specs = withTruthIgnored(inspect.specs);
  const dataset = await loadDataset(source, specs, {
    delimiter: inspect.delimiter,
    estimatedRows: inspect.estimatedRows,
  });
  const result = runPipeline({
    dataset,
    options: { ...DEFAULT_RUN_OPTIONS, k: null, kMin: 2, kMax: 8 },
  });
  assert.ok(result.chosenAutomatically);
  assert.ok(result.k >= 2 && result.k <= 8, `想定外の k: ${result.k}`);
  assert.equal(result.kScores.length, 7);
  // 最小クラスタが極端に小さくないこと
  const minShare = Math.min(...result.clusters.map((c) => c.share));
  assert.ok(minShare >= 0.02, `極端に小さいセグメントができた: ${minShare}`);
});

test('Ward 法でも動作する', async () => {
  const { source, inspect } = await loadDemo(4000);
  const specs = withTruthIgnored(inspect.specs);
  const dataset = await loadDataset(source, specs, {
    delimiter: inspect.delimiter,
    estimatedRows: inspect.estimatedRows,
  });
  const result = runPipeline({
    dataset,
    options: { ...DEFAULT_RUN_OPTIONS, k: 5, algorithm: 'ward' },
  });
  assert.equal(result.k, 5);
  const ari = adjustedRandIndex(result.labels, truthLabels(dataset));
  assert.ok(ari > 0.4, `Ward の一致度が低い: ARI=${ari.toFixed(3)}`);
});

test('数百列でも PCA 経由で動く', async () => {
  // 300 列 × 3000 行、うち 3 つの潜在因子で 4 グループを作る
  const rows = 3000;
  const cols = 300;
  const header: string[] = [];
  for (let c = 0; c < cols; c++) header.push(`f${c}`);
  const lines = [header.join(',')];
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const groupCenters = Array.from({ length: 4 }, () =>
    Array.from({ length: cols }, () => (rand() - 0.5) * 6),
  );
  const truth = new Int32Array(rows);
  for (let r = 0; r < rows; r++) {
    const g = r % 4;
    truth[r] = g;
    const values: string[] = [];
    for (let c = 0; c < cols; c++) {
      values.push((groupCenters[g][c] + (rand() - 0.5) * 2).toFixed(3));
    }
    lines.push(values.join(','));
  }
  const source = new StringTextSource('wide.csv', lines.join('\n'));
  const inspect = await inspectSource(source);
  assert.equal(inspect.specs.length, cols);

  const dataset = await loadDataset(source, inspect.specs, {
    delimiter: inspect.delimiter,
    estimatedRows: inspect.estimatedRows,
  });
  const started = Date.now();
  const result = runPipeline({ dataset, options: { ...DEFAULT_RUN_OPTIONS, k: 4 } });
  const elapsed = Date.now() - started;

  assert.equal(result.featureCount, cols);
  assert.ok(result.reducedDim < cols, 'PCA で圧縮されていない');
  assert.ok(
    adjustedRandIndex(result.labels, truth) > 0.9,
    '高次元データでグループを復元できていない',
  );
  assert.ok(elapsed < 60000, `300列の処理に ${elapsed}ms かかった`);
});

test('出力ファイルを生成できる', async () => {
  const { source, inspect } = await loadDemo(2000);
  const specs = withTruthIgnored(inspect.specs);
  const dataset = await loadDataset(source, specs, {
    delimiter: inspect.delimiter,
    estimatedRows: inspect.estimatedRows,
  });
  const result = runPipeline({ dataset, options: { ...DEFAULT_RUN_OPTIONS, k: 4 } });

  const labeled = await buildLabeledCsv(source, inspect.delimiter, result);
  const text = await labeled.text();
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  assert.equal(lines.length, 2001, 'ヘッダー + 全行が出力されていない');
  assert.ok(lines[0].includes('segment_id'));
  assert.ok(lines[0].includes('segment_name'));
  const firstDataRow = lines[1].split(',');
  const segId = Number(firstDataRow[firstDataRow.length - 2]);
  assert.ok(segId >= 1 && segId <= 4);

  const profile = await buildProfileCsv(result).text();
  assert.ok(profile.includes('累計購入金額'));
  assert.ok(profile.includes('効果量(z)'));

  const summary = await buildSummaryMarkdown(result, 'demo.csv').text();
  assert.ok(summary.includes('# セグメンテーション結果'));
  assert.ok(summary.includes('シルエット係数'));
});

test('列の重み付けが結果に反映される', async () => {
  const { source, inspect } = await loadDemo(3000);
  const base = withTruthIgnored(inspect.specs);
  const dataset = await loadDataset(source, base, {
    delimiter: inspect.delimiter,
    estimatedRows: inspect.estimatedRows,
  });

  const normal = runPipeline({ dataset, options: { ...DEFAULT_RUN_OPTIONS, k: 3 } });

  // 累計購入金額だけを強く重み付けする
  for (const column of dataset.columns) {
    if (column.spec.name === '累計購入金額') column.spec = { ...column.spec, weight: 20 };
  }
  const weighted = runPipeline({ dataset, options: { ...DEFAULT_RUN_OPTIONS, k: 3 } });

  // 対象列そのものの分離度は元から高いので、
  // 「他の列に対してどれだけ支配的になったか」で効果を見る
  const dominance = (r: typeof normal) => {
    const target = r.profiles.find((p) => p.column === '累計購入金額')!.separation;
    const others = r.profiles.filter(
      (p) => p.column !== '累計購入金額' && p.column !== '真のセグメント',
    );
    const mean = others.reduce((a, p) => a + p.separation, 0) / others.length;
    return target / mean;
  };

  assert.ok(
    dominance(weighted) > dominance(normal) * 1.3,
    `重み付けの効果が出ていない: ${dominance(normal).toFixed(2)} → ${dominance(weighted).toFixed(2)}`,
  );
});

test('特徴量が全欠損の行があっても落ちない', async () => {
  const csv = [
    'id,金額,回数,ランク',
    'a,100,3,金',
    'b,,,',
    'c,300,9,銀',
    'd,150,4,金',
    'e,,,',
    'f,900,20,金',
    'g,120,2,銅',
    'h,700,15,銀',
  ].join('\n');
  const source = new StringTextSource('sparse.csv', csv);
  const inspect = await inspectSource(source);
  const dataset = await loadDataset(source, inspect.specs, {
    delimiter: inspect.delimiter,
    estimatedRows: inspect.estimatedRows,
  });
  const result = runPipeline({ dataset, options: { ...DEFAULT_RUN_OPTIONS, k: 2 } });
  assert.equal(result.labels.length, 8);
  assert.equal(result.effectiveRows, 6);
});

test('推定用バッファを超える大きさでも行数をおおむね推定できる', async () => {
  // 2MB を超えるサイズにして、外挿ロジックを通す
  const csv = generateDemoCsv(40000, { seed: 3 });
  const source = new StringTextSource('big.csv', csv);
  const inspect = await inspectSource(source);
  assert.ok(csv.length > 2 * 1024 * 1024, '推定用バッファを超えていない');
  const error = Math.abs(inspect.estimatedRows - 40000) / 40000;
  assert.ok(error < 0.1, `行数の推定誤差が大きい: ${inspect.estimatedRows}`);
});
