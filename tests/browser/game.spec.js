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

  await expect(page.locator('#admin-button')).toBeHidden();
  await page.locator('#admin-cheat-button').click();
  await page.locator('#cheat-form [name=password]').fill('tomo');
  await page.locator('#cheat-submit').click();
  await expect(page.locator('#cheat-error')).toHaveText('パスワードが違います。');
  await page.locator('#cheat-form [name=password]').fill('chun');
  await page.locator('#cheat-submit').click();
  await expect(page.locator('#cheat-dialog')).toBeHidden();
  await expect(page.locator('#admin-cheat-button')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#cheat-button')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#admin-button')).toBeHidden();
  await page.locator('#admin-cheat-button').click();
  await expect(page.locator('#admin-cheat-button')).toHaveAttribute('aria-pressed', 'false');
});

test('ホーム→登録→CPU対戦→操作→結果→履歴', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page).toHaveTitle('DAIKIN DICT F9 テトリス');
  await expect(page.locator('.mascot-disc img')).toBeVisible();
  await expect(page.locator('.mode-grid > .mode-card')).toHaveCount(3);
  await expect(page.locator('.tournament-card #tournament-button')).toBeVisible();
  await expect(page.locator('.online-card #tournament-button')).toHaveCount(0);
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
  // These tests isolate input/rendering; registration is covered by real battles.
  await page.route('**/api/register', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ user: { username: 'mock-player', nickname: 'テストプレーヤー' } })
    })
  );
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

test('3人で部屋に参加し、シードから決勝・優勝まで操作できる', async ({
  browser,
  page
}, testInfo) => {
  const contexts = [await browser.newContext(), await browser.newContext()];
  const pages = [page, await contexts[0].newPage(), await contexts[1].newPage()];
  const errors = [];
  pages.forEach((participant) =>
    participant.on('pageerror', (error) => errors.push(error.message))
  );
  try {
    for (const [index, participant] of pages.entries()) {
      await participant.goto('/');
      await participant.locator('#tournament-button').click();
      await participant.locator('[name=nickname]').fill(`大会参加者${index + 1}`);
      await participant.locator('#auth-submit').click();
      await expect(participant.locator('#tournament-dialog')).toBeVisible();
    }
    await page.locator('[name=capacity]').selectOption('3');
    await page.locator('#room-create-form button').click();
    await expect(page.locator('#tournament-view')).toBeVisible();
    const code = await page.locator('#room-code').textContent();
    for (const participant of pages.slice(1)) {
      await participant.locator('[name=code]').fill(code);
      await participant.locator('#room-join-form button').click();
      await expect(participant.locator('#tournament-view')).toBeVisible();
    }
    await expect(page.locator('#room-start')).toBeEnabled();
    await page.locator('#room-start').click();
    await expect
      .poll(
        async () =>
          (
            await Promise.all(
              pages.map((participant) => participant.locator('#game-view').isVisible())
            )
          ).filter(Boolean).length
      )
      .toBe(2);
    const firstPlayers = [];
    for (const participant of pages)
      if (await participant.locator('#game-view').isVisible()) firstPlayers.push(participant);
    await firstPlayers[0].locator('#forfeit-button').click();
    await firstPlayers[0].locator('#confirm-forfeit').click();
    for (const participant of firstPlayers) {
      await expect(participant.locator('#result-dialog')).toBeVisible();
      await participant.locator('#result-room').click();
    }
    const finalists = [];
    for (const participant of pages)
      if (
        (await participant.locator('#room-ready').isVisible()) &&
        (await participant.locator('#room-ready').isEnabled())
      )
        finalists.push(participant);
    // The seed may already be marked ready from the opening round.
    for (const participant of finalists) await participant.locator('#room-ready').click();
    await expect
      .poll(
        async () =>
          (
            await Promise.all(
              pages.map((participant) => participant.locator('#game-view').isVisible())
            )
          ).filter(Boolean).length
      )
      .toBe(2);
    const finalPlayers = [];
    for (const participant of pages)
      if (await participant.locator('#game-view').isVisible()) finalPlayers.push(participant);
    await finalPlayers[0].locator('#forfeit-button').click();
    await finalPlayers[0].locator('#confirm-forfeit').click();
    for (const participant of finalPlayers) {
      await expect(participant.locator('#result-dialog')).toBeVisible();
      await participant.locator('#result-room').click();
    }
    await expect(page.locator('#room-status')).toContainText('優勝：');
    await expect(page.locator('.bracket-match')).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await page.screenshot({
      path: `test-results/${testInfo.project.name}-tournament.png`,
      fullPage: true
    });
    expect(errors).toEqual([]);
    await page.locator('#room-leave').click();
    await expect(page.locator('#home-view')).toBeVisible();
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test('名前chunだけが時間制限と全ゲームの即時停止・再開を操作できる', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#admin-button')).toBeHidden();
  await page.locator('#account-button').click();
  await page.locator('[name=nickname]').fill('管理者ではない名前');
  await page.locator('#auth-submit').click();
  await expect(page.locator('#admin-button')).toBeHidden();
  await page.locator('#account-button').click();
  await page.locator('[name=nickname]').fill('chun');
  await page.locator('#auth-submit').click();
  await expect(page.locator('#admin-button')).toBeVisible();
  await page.locator('#admin-button').click();
  await expect(page.locator('#admin-controls')).toBeVisible();
  await page.locator('#admin-close').click();
  await page.locator('#cpu-button').click();
  await expect(page.locator('#game-view')).toBeVisible();
  await page.locator('#admin-button').click();
  const minute = Math.floor((Date.now() + 9 * 3600000) / 60000) % 1440;
  const time = (value) =>
    `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  const form = page.locator('#admin-schedule-form');
  await form.locator('[name=start]').fill(time((minute + 1439) % 1440));
  await form.locator('[name=end]').fill(time((minute + 5) % 1440));
  await form.locator('[name=enabled]').check();
  await form.locator('button').click();
  await expect(page.locator('#result-dialog')).toBeVisible();
  await expect(page.locator('#result-detail')).toContainText('ゲーム禁止時間帯');
  await page.locator('#result-home').click();
  await expect(page.locator('#availability-notice')).toBeVisible();
  await expect(page.locator('#cpu-button')).toBeDisabled();
  await page.locator('#admin-button').click();
  await form.locator('[name=enabled]').uncheck();
  await form.locator('button').click();
  await expect(page.locator('#availability-notice')).toBeHidden();
  await page.locator('#admin-close').click();
  await expect(page.locator('#cpu-button')).toBeEnabled();
  await page.locator('#cpu-button').click();
  await expect(page.locator('#game-view')).toBeVisible();
  await page.locator('#admin-button').click();
  await page.locator('#admin-stop-button').click();
  await expect(page.locator('#result-dialog')).toBeVisible();
  await expect(page.locator('#result-detail')).toContainText('管理者によるゲーム停止');
  await page.locator('#result-home').click();
  await expect(page.locator('#cpu-button')).toBeDisabled();
  await expect(page.locator('#availability-notice')).toContainText('停止');
  await page.reload();
  await expect(page.locator('#cpu-button')).toBeDisabled();
  await page.locator('#admin-button').click();
  await page.locator('#admin-resume-button').click();
  await expect(page.locator('#availability-notice')).toBeHidden();
  await expect(page.locator('#cpu-button')).toBeEnabled();
  await page.locator('#admin-close').click();
  await page.locator('#account-button').click();
  await page.locator('[name=nickname]').fill('管理者を終了');
  await page.locator('#auth-submit').click();
  await expect(page.locator('#admin-button')).toBeHidden();
});

test('消去したマスだけに短い演出を表示し、同じ状態通知で再表示しない', async ({
  page
}, testInfo) => {
  const { games, sendState, actions } = await mockBattle(page);
  const game = games[0];
  game.matrix = [
    [1, 1],
    [1, 1]
  ];
  game.x = 0;
  game.y = 13;
  game.lock();
  sendState();
  const alpha = () =>
    page
      .locator('#self-board')
      .evaluate(
        (canvas) =>
          canvas.getContext('2d').getImageData(30, Math.floor((13 * canvas.width) / 9 + 30), 1, 1)
            .data[3]
      );
  await expect.poll(alpha, { intervals: [10], timeout: 1000 }).toBeGreaterThan(0);
  await page
    .locator('#self-board')
    .screenshot({ path: `test-results/${testInfo.project.name}-clear-effect.png` });
  await page.keyboard.press('ArrowLeft');
  expect(actions).toContain('left');
  await page.waitForTimeout(360);
  expect(await alpha()).toBe(0);
  sendState();
  await page.waitForTimeout(40);
  expect(await alpha()).toBe(0);
});

test('対戦へ未接続のホームでも禁止時間の終了を自動反映する', async ({ page }) => {
  await page.clock.install();
  const availability = { enabled: true, start: '22:00', end: '06:00', timezone: 'Asia/Tokyo' };
  await page.route('**/api/me', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ user: null, availability: { ...availability, blocked: true } })
    })
  );
  await page.route('**/api/availability', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ...availability, blocked: false })
    })
  );
  await page.goto('/');
  await expect(page.locator('#cpu-button')).toBeDisabled();
  await expect(page.locator('#availability-notice')).toBeVisible();
  await page.clock.fastForward(15000);
  await expect(page.locator('#cpu-button')).toBeEnabled();
  await expect(page.locator('#availability-notice')).toBeHidden();
});
