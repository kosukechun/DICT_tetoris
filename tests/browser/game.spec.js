import { test, expect } from '@playwright/test';
import { Game } from '../../shared/engine.js';

test('チートモードはパスワードをサーバーで確認してON/OFFできる', async ({ page }) => {
  await page.goto('/');
  await page.locator('#cheat-button').click();
  await expect(page.locator('#auth-dialog')).toBeVisible();
  await page.locator('[name=nickname]').fill('チート確認');
  await page.locator('#auth-submit').click();
  await expect(page.locator('#cheat-dialog')).toBeVisible();

  await page.locator('#cheat-form [name=password]').fill('wrong');
  await page.locator('#cheat-submit').click();
  await expect(page.locator('#cheat-error')).toHaveText('パスワードが違います。');
  await expect(page.locator('#cheat-button')).toHaveAttribute('aria-pressed', 'false');

  await page.locator('#cheat-form [name=password]').fill('tomo');
  await page.locator('#cheat-submit').click();
  await expect(page.locator('#cheat-dialog')).toBeHidden();
  await expect(page.locator('#cheat-button')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#cheat-button b')).toHaveText('ON');

  await page.locator('#cheat-button').click();
  await expect(page.locator('#cheat-button')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#cheat-button b')).toHaveText('OFF');
});

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
  await expect(
    page.locator('#auth-dialog [name=username], #auth-dialog [name=password]')
  ).toHaveCount(0);
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

test('対戦履歴に相手別の勝率・回数・ゲーム時間を表示する', async ({ page }) => {
  await page.goto('/');
  await page.locator('#account-button').click();
  await page.locator('[name=nickname]').fill('戦績テスト');
  await page.locator('#auth-submit').click();
  await page.route('**/api/history', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        matches: [],
        opponentStats: [
          {
            opponent: { username: 'rival', nickname: 'ライバル' },
            games: 3,
            wins: 2,
            losses: 1,
            draws: 0,
            totalDuration: 375_000,
            averageDuration: 125_000,
            winRate: 2 / 3,
            latestAt: '2026-10-21T12:00:00.000Z'
          }
        ]
      })
    })
  );

  await page.locator('#history-nav').click();
  const card = page.locator('.opponent-card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('vs ライバル');
  await expect(card).toContainText('勝率 6割7分');
  await expect(card).toContainText('3回');
  await expect(card).toContainText('2勝 1敗 0分');
  await expect(card).toContainText('合計 6分15秒');
  await expect(card).toContainText('2分5秒');
});

async function mockBattle(page) {
  const games = [new Game(7), new Game(7)];
  const actions = [];
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
      const message = JSON.parse(data);
      if (message.type === 'action') {
        actions.push(message.action);
        return;
      }
      if (message.type !== 'join') return;
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
  return { games, sendState, actions };
}

test('下矢印の長押しは60ms間隔で左右移動より速く送信する', async ({ page }) => {
  const { actions } = await mockBattle(page);
  await page.keyboard.down('ArrowDown');
  await page.waitForTimeout(1000);
  await page.keyboard.up('ArrowDown');
  const downCount = actions.filter((action) => action === 'down').length;
  actions.length = 0;
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(1000);
  await page.keyboard.up('ArrowLeft');
  const leftCount = actions.filter((action) => action === 'left').length;
  expect(downCount).toBeGreaterThanOrEqual(leftCount * 1.15);
  expect(downCount).toBeLessThanOrEqual(leftCount * 1.7);
});

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
    expect(Math.abs(board.height / board.width - 5 / 3)).toBeLessThan(0.02);
    if (viewport.width === 1920) expect(board.width).toBeGreaterThanOrEqual(430);
  }
});

test('相殺した数と予告の変化を大きく表示し、同じ通知を繰り返さない', async ({ page }, testInfo) => {
  const { games, sendState } = await mockBattle(page);
  const game = games[0];
  await page.evaluate(() => {
    window.cancelDurations = [];
    const notice = document.querySelector('#self-cancel');
    let shownAt = null;
    new MutationObserver(() => {
      if (!notice.hidden) shownAt = performance.now();
      else if (shownAt !== null) {
        window.cancelDurations.push(performance.now() - shownAt);
        shownAt = null;
      }
    }).observe(notice, { attributes: true, attributeFilter: ['hidden'] });
  });
  game.receive(3);
  sendState();
  await expect(page.locator('#self-garbage i')).toHaveCount(3);
  game.matrix = [Array(8).fill(1)];
  game.x = 0;
  game.y = game.board.length - 1;
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
  await expect(notice).toBeHidden({ timeout: 500 });
  const duration = await page.evaluate(() => window.cancelDurations.at(-1));
  expect(duration).toBeGreaterThanOrEqual(200);
  expect(duration).toBeLessThanOrEqual(300);
  sendState();
  await expect(notice).toBeHidden();
});
