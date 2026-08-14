import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { detectDelimiter, normalizeHeader, parseCsvText, CsvParser } from '../src/core/csv.ts';

test('シンプルな CSV を分解できる', () => {
  const rows = parseCsvText('a,b,c\n1,2,3\n', ',');
  assert.deepEqual(rows, [
    ['a', 'b', 'c'],
    ['1', '2', '3'],
  ]);
});

test('クォート内の区切り文字・改行・エスケープを扱える', () => {
  const text = 'name,memo\n"山田, 太郎","1行目\n2行目"\n"引用""符",ok\n';
  const rows = parseCsvText(text, ',');
  assert.deepEqual(rows, [
    ['name', 'memo'],
    ['山田, 太郎', '1行目\n2行目'],
    ['引用"符', 'ok'],
  ]);
});

test('CRLF と末尾改行なしを扱える', () => {
  const rows = parseCsvText('a,b\r\n1,2\r\n3,4', ',');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['1', '2'],
    ['3', '4'],
  ]);
});

test('空フィールドと空行を正しく扱う', () => {
  const rows = parseCsvText('a,b,c\n1,,3\n\n4,5,6\n', ',');
  assert.deepEqual(rows, [
    ['a', 'b', 'c'],
    ['1', '', '3'],
    ['4', '5', '6'],
  ]);
});

test('チャンク境界がどこにあっても結果が変わらない', () => {
  const text = 'a,b\n"x,1","改\n行"\n"q""q",z\n最後,行\n';
  const expected = parseCsvText(text, ',');
  for (let split = 1; split < text.length; split++) {
    const rows: string[][] = [];
    const parser = new CsvParser(',', (fields, count) => rows.push(fields.slice(0, count)));
    parser.write(text.slice(0, split));
    parser.write(text.slice(split));
    parser.end();
    assert.deepEqual(rows, expected, `split=${split} で結果が変わった`);
  }
});

test('区切り文字を自動判定する', () => {
  assert.equal(detectDelimiter('a,b,c\n1,2,3\n4,5,6\n'), ',');
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3\n4\t5\t6\n'), '\t');
  assert.equal(detectDelimiter('a;b;c\n1;2;3\n4;5;6\n'), ';');
});

test('カンマを含む値があってもタブ区切りを誤判定しない', () => {
  const text = 'name\tmemo\n山田\t東京, 渋谷\n田中\t大阪, 北区\n';
  assert.equal(detectDelimiter(text), '\t');
});

test('ヘッダー名の重複・空欄を補完する', () => {
  const header = normalizeHeader(['a', '', 'a', 'b'], 4);
  assert.deepEqual(header, ['a', '列2', 'a_2', 'b']);
});

test('数十万行でも現実的な速度でパースできる', () => {
  const rowCount = 200000;
  const parts: string[] = ['c1,c2,c3,c4,c5'];
  for (let i = 0; i < rowCount; i++) parts.push(`${i},"a,b",${i * 2},テキスト,${i % 7}`);
  const text = parts.join('\n');

  const started = Date.now();
  let seen = 0;
  const parser = new CsvParser(',', (_fields, count) => {
    seen++;
    assert.equal(count, 5);
  });
  parser.write(text);
  parser.end();
  const elapsed = Date.now() - started;

  assert.equal(seen, rowCount + 1);
  assert.ok(elapsed < 8000, `20万行のパースに ${elapsed}ms かかった`);
});
