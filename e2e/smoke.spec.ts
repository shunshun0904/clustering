import { expect, test } from '@playwright/test';

const SHIFT_JIS_CSV = 'e2e/fixtures/sjis-sample.csv';

test('デモデータを読み込んでクラスタリングし、結果が表示される', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: /よしなにクラスタリング/ })).toBeVisible();

  await page.getByRole('button', { name: /デモデータで試す/ }).click();

  // 列推定が終わり、ID 列が自動的に除外されていること
  await expect(page.getByRole('tab', { name: /列の設定/ })).toBeVisible();
  const idRow = page.locator('tr', { has: page.getByText('顧客ID', { exact: true }) });
  await expect(idRow.locator('select').nth(1)).toHaveValue('ignore');

  await page.getByRole('button', { name: 'クラスタリングを実行' }).click();

  // 結果タブに切り替わり、セグメントカードが出る
  await expect(page.getByText('分離の良さ（シルエット）')).toBeVisible({ timeout: 120_000 });
  const cards = page.locator('.cluster-card');
  const cardCount = await cards.count();
  expect(cardCount).toBeGreaterThanOrEqual(2);

  // 構成比の合計がおよそ 100%
  const shares = await page.locator('.cluster-size').allInnerTexts();
  const total = shares
    .map((text) => Number(text.match(/([\d.]+)%/)?.[1] ?? 0))
    .reduce((a, b) => a + b, 0);
  expect(total).toBeGreaterThan(99);
  expect(total).toBeLessThan(101);

  // 散布図が描画されている
  const canvas = page.locator('canvas.scatter-canvas');
  await expect(canvas).toBeVisible();
  const painted = await canvas.evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext('2d');
    if (!ctx) return 0;
    const data = ctx.getImageData(0, 0, el.width, el.height).data;
    let nonEmpty = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) nonEmpty++;
    return nonEmpty;
  });
  expect(painted).toBeGreaterThan(1000);

  // 列プロファイルに数値列とカテゴリ列が出ている
  await expect(page.getByRole('heading', { name: '列ごとのセグメント比較' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '累計購入金額' })).toBeVisible();

  expect(errors).toEqual([]);
});

test('k を手動指定して再実行できる', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /デモデータで試す/ }).click();
  await expect(page.getByRole('tab', { name: /列の設定/ })).toBeVisible();

  await page.getByRole('button', { name: '指定する' }).click();
  await page.getByRole('spinbutton', { name: 'セグメント数' }).fill('6');
  await page.getByRole('button', { name: 'クラスタリングを実行' }).click();

  await expect(page.getByText('分離の良さ（シルエット）')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('.cluster-card')).toHaveCount(6);
});

test('Shift_JIS の CSV を文字化けせず読める', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', SHIFT_JIS_CSV);

  await expect(page.getByRole('tab', { name: /列の設定/ })).toBeVisible();
  await expect(page.getByText('SHIFT_JIS')).toBeVisible();
  await expect(page.getByRole('cell', { name: '会員ランク', exact: true })).toBeVisible();
  await expect(page.getByText('ゴールド', { exact: false }).first()).toBeVisible();
});

test('セグメント付き CSV をダウンロードできる', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /デモデータで試す/ }).click();
  await expect(page.getByRole('tab', { name: /列の設定/ })).toBeVisible();
  await page.getByRole('button', { name: 'クラスタリングを実行' }).click();
  await expect(page.getByText('分離の良さ（シルエット）')).toBeVisible({ timeout: 120_000 });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /元データ \+ セグメント列/ }).click(),
  ]);
  expect(download.suggestedFilename()).toContain('_segments.csv');
});

// スマートフォン幅でヘッダーが崩れないこと。
// flex の 1 行レイアウトのままだと各要素が潰れて 1 文字ずつ改行され、
// ヘッダーだけで画面が埋まってしまう回帰があったため固定で確認する。
test('スマートフォン幅でヘッダーが崩れない', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: /デモデータで試す/ }).click();
  await expect(page.getByRole('tab', { name: /列の設定/ })).toBeVisible();

  const metrics = await page.evaluate(() => {
    const topbar = document.querySelector('.topbar') as HTMLElement;
    return {
      topbarHeight: topbar.getBoundingClientRect().height,
      docWidth: document.documentElement.scrollWidth,
      winWidth: window.innerWidth,
    };
  });

  // ヘッダーは 2 行程度に収まること（崩れると 500px 超になる）
  expect(metrics.topbarHeight).toBeLessThan(140);
  // 横スクロールが発生しないこと
  expect(metrics.docWidth).toBeLessThanOrEqual(metrics.winWidth);

  // ボタン類が途中で折り返していないこと（1 行に収まる高さか）
  const resetButton = page.getByRole('button', { name: '別のファイル' });
  const box = await resetButton.boundingBox();
  expect(box!.height).toBeLessThan(34);
});
