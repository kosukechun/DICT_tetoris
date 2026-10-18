import { test, expect } from '@playwright/test';
test('ホーム→登録→CPU対戦→操作→結果→履歴', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page).toHaveTitle('DAIKIN DICT F9 テトリス');
  await expect(page.locator('.mascot-disc img')).toBeVisible();
  expect(await page.locator('body').evaluate((el) => el.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `test-results/${testInfo.project.name}-home.png`, fullPage: true });
  await page.locator('#cpu-button').click();
  await expect(page.locator('#auth-dialog')).toBeVisible();
  await expect(page.locator('[name=username], [name=password]')).toHaveCount(0);
  await page.locator('[name=nickname]').fill('テストプレーヤー');
  await page.locator('#auth-submit').click();
  await expect(page.locator('#game-view')).toBeVisible();
  await expect(page.locator('#countdown')).toHaveText('', { timeout: 6000 });
  const self = await page.locator('#self-board').boundingBox(),
    rival = await page.locator('#rival-board').boundingBox();
  expect(self.x).toBeLessThan(rival.x);
  if (testInfo.project.name === 'desktop') expect(self.width).toBeGreaterThanOrEqual(350);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await expect(page.locator('#self-score')).not.toHaveText('0');
  await page.locator('#shield-button').click();
  await expect(page.locator('#shield-button')).toBeDisabled();
  expect(await page.locator('body').evaluate((el) => el.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-battle.png`,
    fullPage: true
  });
  await page.locator('#forfeit-button').click();
  await page.locator('#confirm-forfeit').click();
  await expect(page.locator('#result-dialog')).toBeVisible();
  await expect(page.locator('#save-status')).toContainText('保存しました');
  await page.locator('#result-history').click();
  await expect(page.locator('.history-row')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('#player-label')).toHaveText('テストプレーヤー');
  await page.locator('#account-button').click();
  await page.locator('[name=nickname]').fill('名前を変更');
  await page.locator('#auth-submit').click();
  await expect(page.locator('#player-label')).toHaveText('名前を変更');
  await page.locator('#history-nav').click();
  await expect(page.locator('.history-row')).toHaveCount(1);
  await expect(page.locator('footer')).toContainText('製作者：ちゅん丸');
  await page.getByRole('link', { name: '遊び方' }).click();
  await expect(page.locator('#guide-view')).toBeVisible();
  expect(errors).toEqual([]);
});
