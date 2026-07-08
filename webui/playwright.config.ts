import { defineConfig } from '@playwright/test';
import path from 'node:path';

const e2eDir = path.resolve(__dirname, 'e2e');
const libraryDir = path.join(e2eDir, '.library');
const trashDir = path.join(e2eDir, '.trash');
const API_PORT = 8799;
const WEB_PORT = 5199;

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/seed.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: './e2e/test-results',
  snapshotPathTemplate: '{testDir}/baselines/{arg}{ext}',
  expect: {
    toHaveScreenshot: { maxDiffPixels: 100 },
  },
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  },
  webServer: [
    {
      command: `bash -c 'rm -rf "${libraryDir}" "${trashDir}" && mkdir -p "${trashDir}" && cd ../api && API_PORT=${API_PORT} ../.venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port ${API_PORT}'`,
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      env: {
        COMIC_CANVAS_HOME: libraryDir,
        COMIC_CANVAS_TRASH_DIR: trashDir,
      },
      timeout: 30_000,
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      env: { API_PORT: String(API_PORT) },
      timeout: 30_000,
    },
  ],
});
