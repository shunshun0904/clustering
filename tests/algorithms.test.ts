import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { kmeans } from '../src/core/kmeans.ts';
import { buildWardTree, labelsFromTree } from '../src/core/ward.ts';
import { fitPca, projectBlock, jacobiEigen } from '../src/core/pca.ts';
import { silhouetteScore } from '../src/core/metrics.ts';
import { makeGaussian, makeRng, sampleIndices } from '../src/core/rng.ts';
import { computeNumericStats, probit } from '../src/core/stats.ts';
import { parseNumberLoose, parseDateLoose, inferColumn } from '../src/core/infer.ts';
import { adjustedRandIndex, makeBlobs } from './helpers.ts';

test('k-means が分離した塊を復元する', () => {
  const { x, truth, n } = makeBlobs(400, 4, 6, 8, 3);
  const result = kmeans(x, n, 6, 4, { seed: 42 });
  assert.ok(adjustedRandIndex(result.labels, truth) > 0.95, 'ARI が低い');
});

test('k-means は空クラスタを残さない', () => {
  const { x, n } = makeBlobs(100, 2, 3, 10, 5);
  const result = kmeans(x, n, 3, 8, { seed: 1 });
  const counts = new Int32Array(8);
  for (let i = 0; i < n; i++) counts[result.labels[i]]++;
  for (let c = 0; c < 8; c++) assert.ok(counts[c] > 0, `クラスタ ${c} が空`);
});

test('ミニバッチ経路（大規模）でも塊を復元する', () => {
  const { x, truth, n } = makeBlobs(15000, 4, 5, 9, 11);
  const started = Date.now();
  const result = kmeans(x, n, 5, 4, { seed: 42 });
  const elapsed = Date.now() - started;
  assert.ok(adjustedRandIndex(result.labels, truth) > 0.95, 'ARI が低い');
  assert.ok(elapsed < 20000, `6万行の k-means に ${elapsed}ms かかった`);
});

test('Ward 法が分離した塊を復元する', () => {
  const { x, truth, n } = makeBlobs(150, 4, 4, 8, 7);
  const tree = buildWardTree(x, n, 4);
  const labels = labelsFromTree(tree, 4);
  assert.equal(new Set(Array.from(labels)).size, 4);
  assert.ok(adjustedRandIndex(labels, truth) > 0.95, 'ARI が低い');
});

test('Ward の樹形図は任意の k で切れる', () => {
  const { x, n } = makeBlobs(60, 3, 3, 6, 9);
  const tree = buildWardTree(x, n, 3);
  for (const k of [2, 3, 5, 10]) {
    const labels = labelsFromTree(tree, k);
    assert.equal(new Set(Array.from(labels)).size, k, `k=${k} で分割数が違う`);
  }
});

test('PCA が主要な分散方向を見つける', () => {
  // x 軸方向に 10 倍広がったデータ
  const n = 2000;
  const d = 5;
  const rng = makeRng(4);
  const gauss = makeGaussian(rng);
  const x = new Float32Array(n * d);
  for (let i = 0; i < n; i++) {
    const t = gauss() * 10;
    x[i * d] = t;
    x[i * d + 1] = t * 0.5 + gauss() * 0.1;
    for (let j = 2; j < d; j++) x[i * d + j] = gauss() * 0.1;
  }
  const model = fitPca(x, n, d, 3, 42);
  assert.ok(model.explainedRatio[0] > 0.95, `第1主成分の寄与率が低い: ${model.explainedRatio[0]}`);
  // 第1主成分は x-y 平面に乗っているはず
  const load = model.components;
  assert.ok(Math.abs(load[0]) + Math.abs(load[1]) > 0.95);
});

test('PCA の射影がユークリッド距離をおおむね保つ', () => {
  const { x, n } = makeBlobs(200, 3, 20, 5, 13);
  const d = 20;
  const model = fitPca(x, n, d, 20, 42);
  const proj = new Float32Array(n * model.k);
  projectBlock(model, x, n, proj, 0);

  const rng = makeRng(3);
  for (let t = 0; t < 50; t++) {
    const i = Math.floor(rng() * n);
    const j = Math.floor(rng() * n);
    if (i === j) continue;
    let before = 0;
    for (let c = 0; c < d; c++) {
      const diff = x[i * d + c] - x[j * d + c];
      before += diff * diff;
    }
    let after = 0;
    for (let c = 0; c < model.k; c++) {
      const diff = proj[i * model.k + c] - proj[j * model.k + c];
      after += diff * diff;
    }
    const ratio = Math.sqrt(after / before);
    assert.ok(ratio > 0.95 && ratio < 1.05, `距離が歪んだ: ${ratio}`);
  }
});

test('Jacobi 法が既知の固有値を返す', () => {
  // 対角行列 diag(3,1,2)
  const m = new Float64Array([3, 0, 0, 0, 1, 0, 0, 0, 2]);
  const { values } = jacobiEigen(m, 3);
  const sorted = Array.from(values).sort((a, b) => b - a);
  assert.ok(Math.abs(sorted[0] - 3) < 1e-9);
  assert.ok(Math.abs(sorted[1] - 2) < 1e-9);
  assert.ok(Math.abs(sorted[2] - 1) < 1e-9);
});

test('シルエット係数が分離度を反映する', () => {
  const good = makeBlobs(200, 3, 4, 12, 21);
  const goodFit = kmeans(good.x, good.n, 4, 3, { seed: 1 });
  const idx = sampleIndices(good.n, 300, makeRng(1));
  const goodScore = silhouetteScore(good.x, 4, goodFit.labels, idx, 3);

  // 分離していないデータ
  const rng = makeRng(2);
  const gauss = makeGaussian(rng);
  const n = 600;
  const flat = new Float32Array(n * 4);
  for (let i = 0; i < n * 4; i++) flat[i] = gauss();
  const flatFit = kmeans(flat, n, 4, 3, { seed: 1 });
  const flatScore = silhouetteScore(flat, 4, flatFit.labels, sampleIndices(n, 300, makeRng(1)), 3);

  assert.ok(goodScore > 0.6, `分離データのシルエットが低い: ${goodScore}`);
  assert.ok(flatScore < goodScore - 0.3, `分離していないデータのシルエットが高い: ${flatScore}`);
});

test('数値統計が正しい', () => {
  const values = new Float64Array([1, 2, 3, 4, 5, NaN, 100]);
  const stats = computeNumericStats(values);
  assert.equal(stats.count, 6);
  assert.equal(stats.missing, 1);
  assert.ok(Math.abs(stats.mean - 115 / 6) < 1e-9);
  assert.equal(stats.min, 1);
  assert.equal(stats.max, 100);
  assert.ok(stats.skewness > 1, '右に裾を引いているはず');
});

test('probit が標準正規の分位点を返す', () => {
  assert.ok(Math.abs(probit(0.5)) < 1e-6);
  assert.ok(Math.abs(probit(0.975) - 1.959964) < 1e-3);
  assert.ok(Math.abs(probit(0.025) + 1.959964) < 1e-3);
});

test('緩い数値パースが業務データの表記を扱える', () => {
  assert.equal(parseNumberLoose('1,234'), 1234);
  assert.equal(parseNumberLoose('¥1,234'), 1234);
  assert.equal(parseNumberLoose('12.5%'), 0.125);
  assert.equal(parseNumberLoose('(1,200)'), -1200);
  assert.equal(parseNumberLoose('１２３'), 123);
  assert.equal(parseNumberLoose('1.5e3'), 1500);
  assert.ok(Number.isNaN(parseNumberLoose('東京')));
  assert.ok(Number.isNaN(parseNumberLoose('12月3日')));
});

test('日付パースが主要な書式を扱える', () => {
  assert.equal(parseDateLoose('2024-03-15'), Date.UTC(2024, 2, 15));
  assert.equal(parseDateLoose('2024/3/15'), Date.UTC(2024, 2, 15));
  assert.equal(parseDateLoose('2024年3月15日'), Date.UTC(2024, 2, 15));
  assert.equal(parseDateLoose('2024-03-15 10:30'), Date.UTC(2024, 2, 15, 10, 30));
  assert.ok(Number.isNaN(parseDateLoose('2024-13-45')));
});

test('列の型推定がそれらしく動く', () => {
  const numeric = inferColumn({
    name: '購入金額',
    index: 0,
    values: ['1200', '3400', '890', '15000', '2300'],
  });
  assert.equal(numeric.kind, 'numeric');
  assert.equal(numeric.role, 'feature');

  const category = inferColumn({
    name: '会員ランク',
    index: 1,
    values: Array.from({ length: 100 }, (_, i) => ['金', '銀', '銅'][i % 3]),
  });
  assert.equal(category.kind, 'categorical');
  assert.equal(category.role, 'feature');

  const id = inferColumn({
    name: '顧客ID',
    index: 2,
    values: Array.from({ length: 100 }, (_, i) => `C${100000 + i}`),
  });
  assert.equal(id.kind, 'identifier');
  assert.equal(id.role, 'ignore');

  const date = inferColumn({
    name: '最終購入日',
    index: 3,
    values: ['2024-01-05', '2024-02-11', '2023-12-30', '2024-03-01'],
  });
  assert.equal(date.kind, 'datetime');

  const text = inferColumn({
    name: '問い合わせ内容',
    index: 4,
    values: [
      '商品が届かないので状況を確認してほしいです。よろしくお願いします。',
      '返品したいのですが手続きの方法を教えてください。',
      'サイズが合わなかったため交換をお願いしたいです。',
    ],
  });
  assert.equal(text.kind, 'text');
  assert.equal(text.role, 'ignore');

  const constant = inferColumn({
    name: '国',
    index: 5,
    values: ['日本', '日本', '日本', '日本'],
  });
  assert.equal(constant.kind, 'constant');
  assert.equal(constant.role, 'ignore');
});
