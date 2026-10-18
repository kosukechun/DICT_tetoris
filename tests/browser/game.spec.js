import { test, expect } from '@playwright/test';
import { Game } from '../../shared/engine.js';
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
  if (testInfo.project.name === 'desktop') {
    expect(self.width).toBeGreaterThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(
      true
    );
  }
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

async function mockBattle(page) {
  const games = [new Game(7), new Game(7)];
  let battleSocket;
  const sendState = () =>
    battleSocket.send(
      JSON.stringify({
        type: 'state',
        states: games.map((g) => g.snapshot()),
        elapsed: 0
      })
    );
  await page.routeWebSocket('**/ws', (ws) => {
    battleSocket = ws;
    ws.send(JSON.stringify({ type: 'ready' }));
    ws.onMessage((data) => {
      if (JSON.parse(data).type !== 'join') return;
      ws.send(
        JSON.stringify({
          type: 'start',
          id: 'layout-preview',
          seat: 0,
          difficulty: 'normal',
          players: [{ nickname: 'テストプレーヤー' }, { nickname: 'CPU' }],
          startsAt: Date.now(),
          serverNow: Date.now()
        })
      );
      sendState();
    });
  });
  await page.goto('/');
  await page.locator('#cpu-button').click();
  await page.locator('[name=nickname]').fill('テストプレーヤー');
  await page.locator('#auth-submit').click();
  await expect(page.locator('#game-view')).toBeVisible();
  return { games, sendState };
}

test('PCの各画面サイズで盤面と操作がスクロールなしで収まる', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop');
  await page.goto('/');
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1440, height: 1000 },
    { width: 1366, height: 768 },
    { width: 1280, height: 720 },
    { width: 1024, height: 768 }
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(
        () =>
          page.evaluate(() => ({
            width: document.documentElement.scrollWidth <= innerWidth,
            height: document.documentElement.scrollHeight <= innerHeight
          })),
        { message: `home ${JSON.stringify(viewport)}` }
      )
      .toEqual({ width: true, height: true });
  }
  const { games, sendState } = await mockBattle(page);
  games[0].receive(20);
  sendState();
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1440, height: 1000 },
    { width: 1440, height: 900 },
    { width: 1366, height: 768 },
    { width: 1280, height: 720 },
    { width: 1024, height: 768 }
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(
        async () =>
          page.evaluate(() => ({
            width: document.documentElement.scrollWidth <= innerWidth,
            height: document.documentElement.scrollHeight <= innerHeight,
            controls:
              document.querySelector('.game-controls').getBoundingClientRect().bottom <=
              innerHeight,
            board:
              document.querySelector('#self-board').getBoundingClientRect().bottom <= innerHeight,
            sidebar:
              document.querySelector('.board-sidebar').getBoundingClientRect().bottom <= innerHeight
          })),
        { message: JSON.stringify(viewport) }
      )
      .toEqual({
        width: true,
        height: true,
        controls: true,
        board: true,
        sidebar: true
      });
    const board = await page.locator('#self-board').boundingBox();
    expect(Math.abs(board.height / board.width - 2)).toBeLessThan(0.02);
    if (viewport.width === 1920) expect(board.width).toBeGreaterThanOrEqual(430);
  }
});

test('相殺した数と予告の変化を大きく表示し、同じ通知を繰り返さない', async ({ page }, testInfo) => {
  const { games, sendState } = await mockBattle(page);
  const game = games[0];
  game.receive(3);
  sendState();
  await expect(page.locator('#self-garbage i')).toHaveCount(3);
  game.matrix = [Array(8).fill(1)];
  game.x = 0;
  game.y = 19;
  game.lock();
  sendState();
  const notice = page.locator('#self-cancel');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('相殺！');
  await expect(notice).toContainText('2個 打ち消した！');
  await expect(notice).toContainText('予告 3個 → 残り 1個');
  await expect(page.locator('#self-pending')).toHaveText('1');
  await expect(page.locator('#self-garbage i')).toHaveCount(1);
  const bounds = await notice.boundingBox();
  const board = await page.locator('#self-board').boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(board.x);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(board.x + board.width);
  expect(
    await notice.locator('strong').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
  ).toBeGreaterThanOrEqual(28);
  await notice.evaluate((el) =>
    Promise.all(el.getAnimations().map((animation) => animation.finished))
  );
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-cancel.png`,
    fullPage: true
  });
  await expect(notice).toBeHidden({ timeout: 4000 });
  sendState();
  await expect(notice).toBeHidden();
});
