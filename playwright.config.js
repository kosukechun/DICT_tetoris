import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:3198', trace: 'retain-on-failure' },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } }
    },
    { name: 'mobile', use: { ...devices['Pixel 7'] } }
  ],
  webServer: {
    command: 'node server/index.js',
    url: 'http://127.0.0.1:3198/health',
    reuseExistingServer: false,
    env: {
      PORT: '3198',
      DATA_DIR: 'data/browser-tests',
      NODE_ENV: 'test',
      DYNAMODB_TABLE: ''
    }
  }
});
