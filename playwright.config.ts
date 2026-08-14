import { defineConfig } from '@playwright/test';

/**
 * Worker / Canvas を含む経路は Node のユニットテストでは検証できないため、
 * 実ブラウザでの疎通テストを用意している。
 *   npm run build && npm run e2e
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'off',
    // 既にブラウザが入っている環境では PW_CHROMIUM_PATH で実行ファイルを指定できる
    launchOptions: process.env.PW_CHROMIUM_PATH
      ? { executablePath: process.env.PW_CHROMIUM_PATH }
      : {},
  },
  webServer: {
    command: 'npm run preview -- --port 4173 --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
