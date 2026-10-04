// 端到端测试：加载本插件的 Chromium + 本地仿真抖音站点（test/sim），绝不访问真实抖音。
// 运行：npm run e2e
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'test/e2e',
  timeout: 60_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  workers: 4,
  reporter: [['list']],
  outputDir: 'test/.results',
});
