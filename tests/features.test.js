import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, clearColors, emptyBoard, fits, HEIGHT, GARBAGE_FALL_MS } from '../shared/engine.js';
import { Matchmaker, CHEAT_INTERVAL_MS, countBoardBlocks } from '../server/matches.js';
import { PlayAccess } from '../server/access.js';

function context(count = 3) {
  const clock = { value: Date.parse('2026-10-25T03:00:00Z') };
  const records = new Map();
  const store = {
    async get(pk, sk) {
      return records.get(pk + sk);
    },
    async put(item) {
      records.set(item.pk + item.sk, structuredClone(item));
    }
  };
  const access = new PlayAccess(store);
  const maker = new Matchmaker(store, {
    now: () => clock.value,
    access
  });
  const clients = Array.from({ length: count }, (_, index) =>
    maker.add(
      { username: `player-${index}`, nickname: `参加者${index + 1}` },
      {
        readyState: 1,
        messages: [],
        send(data) {
          this.messages.push(JSON.parse(data));
        },
        close() {}
      }
    )
  );
  const last = (client, type) => client.ws.messages.findLast((message) => message.type === type);
  return { clock, records, store, access, maker, clients, last };
}

test('回帰: 消去した列の外で落下したブロックも判定し、3連鎖まで消す', () => {
  const board = emptyBoard();
  for (const y of [13, 14]) for (const x of [0, 1]) board[y][x] = 1;
  for (const y of [12, 14]) for (const x of [6, 7]) board[y][x] = 2;
  for (const y of [10, 11]) board[y][7] = 3;
  for (const y of [13, 14]) board[y][8] = 3;
  const original = structuredClone(board);
  const result = clearColors(board, [[0, 13]]);
  assert.equal(result.count, 12);
  assert.equal(result.chains, 3);
  assert.equal(result.board.flat().filter(Boolean).length, 0);
  assert.deepEqual(
    result.waves.map((wave) => wave.length),
    [4, 4, 4]
  );
  assert.deepEqual(board, original, 'CPUの盤面評価が元の盤面を変更しない');
});

test('消去演出の座標と連鎖数を通知し、演出中も入力を処理する', () => {
  const game = new Game(1);
  game.matrix = [
    [1, 1],
    [1, 1]
  ];
  game.x = 0;
  game.y = HEIGHT - 2;
  game.lock();
  const state = game.snapshot();
  assert.equal(state.lastChains, 1);
  assert.equal(state.clearEffect.cells.length, 4);
  assert.deepEqual(state.clearEffect.cells[0], [0, 13, 1]);
  const pieces = game.pieces;
  game.action('drop');
  assert.equal(game.pieces, pieces + 1);
});

test('天井より上のブロックを固定した場合も例外を出さず敗北にする', () => {
  const game = new Game(1);
  game.matrix = [
    [1, 2],
    [3, 4]
  ];
  game.y = -1;
  game.board[1].fill(8);
  assert.doesNotThrow(() => game.lock());
  assert.equal(game.over, true);
  assert.equal(game.board.flat().filter(Boolean).length, 9);
});

for (let capacity = 3; capacity <= 8; capacity++) {
  test(`${capacity}人: 部屋参加からシード・全試合・優勝まで進行する`, async () => {
    const { maker, clients, last } = context(capacity + 1);
    const host = clients[0];
    maker.tournament(host, 'create', { capacity });
    const code = host.room;
    const room = maker.tournaments.rooms.get(code);
    maker.tournament(clients[1], 'start', {});
    assert.equal(room.status, 'lobby', '主催者以外は開始できない');
    maker.tournament(host, 'start', {});
    assert.equal(room.status, 'lobby', '定員未満は開始できない');
    clients
      .slice(1, capacity)
      .forEach((client) => maker.tournament(client, 'join', { code: code.toLowerCase() }));
    maker.tournament(clients[capacity], 'join', { code });
    assert.equal(clients[capacity].room, null, '満員の部屋へは入れない');
    assert.equal(last(host, 'tournament').room.members.length, capacity);
    maker.join(host, 'cpu');
    assert.equal(host.match, null, '部屋参加中の通常対戦を防ぐ');
    maker.tournament(host, 'start', {});
    const first = room.rounds[0];
    assert.equal(
      first.filter((entry) => entry.reason === 'bye').length,
      2 ** Math.ceil(Math.log2(capacity)) - capacity
    );
    assert.equal(
      new Set(
        first.flatMap((entry) => entry.players.filter(Boolean).map((player) => player.username))
      ).size,
      capacity
    );
    let played = 0;
    while (room.status === 'running' && played < 10) {
      const matches = [...maker.matches.values()];
      if (!matches.length) {
        clients.forEach((client) => maker.tournaments.ready(client));
        assert.ok(maker.matches.size, '準備完了で次の試合を開始する');
        continue;
      }
      for (const match of matches) {
        maker.finish(match, 0, 'topout');
        played++;
      }
    }
    assert.equal(room.status, 'finished');
    assert.equal(played, capacity - 1);
    assert.ok(room.champion);
    assert.equal(maker.matches.size, 0);
    await Promise.all([...maker.pendingWrites]);
  });
}

test('引き分けは両者の再準備後に再試合し、退出した参加者は不戦敗になる', async () => {
  const { maker, clients } = context();
  maker.tournaments.create(clients[0], 3);
  const room = maker.tournaments.rooms.get(clients[0].room);
  clients.slice(1).forEach((client) => maker.tournaments.join(client, room.code));
  maker.tournaments.start(clients[0]);
  const match = [...maker.matches.values()][0];
  maker.finish(match, null, 'time');
  assert.equal(maker.matches.size, 0);
  maker.tournaments.ready(match.clients[0]);
  assert.equal(maker.matches.size, 0);
  maker.tournaments.ready(match.clients[1]);
  const replay = match.clients[0].match;
  assert.ok(replay);
  assert.notEqual(replay.id, match.id);
  const leaver = replay.clients[1];
  maker.remove(leaver);
  assert.equal(leaver.room, null);
  assert.equal(replay.finished, true);
  const final = room.rounds.at(-1);
  assert.equal(final.length, 1);
  assert.equal(final[0].players.filter(Boolean).length, 2);
  assert.ok(final[0].players.every((player) => player.username !== leaver.user.username));
  await maker.shutdown();
});

test('部屋の人数検証・主催者退出時の引き継ぎ・最後の退出で部屋を破棄する', () => {
  const { maker, clients } = context();
  for (const capacity of [2, 9, 3.5, '4', null]) {
    maker.tournaments.create(clients[0], capacity);
    assert.equal(clients[0].room, null);
  }
  maker.tournaments.create(clients[0], 3);
  const code = clients[0].room;
  maker.tournaments.join(clients[1], code);
  maker.tournaments.leave(clients[0]);
  assert.equal(maker.tournaments.rooms.get(code).host, clients[1].user.username);
  maker.tournaments.leave(clients[1]);
  assert.equal(maker.tournaments.rooms.size, 0);
});

test('adminチートはchunだけを受け付け、通常チート併用でも5秒ごとに3個消去・2個攻撃する', async () => {
  const { maker, clients, clock, last } = context(2);
  const [admin, rival] = clients;
  maker.setAdminCheat(admin, true);
  assert.equal(admin.adminCheat, false);
  maker.setAdminCheat(admin, true, 'tomo');
  assert.equal(admin.adminCheat, false, '通常チートのパスワードでは有効化しない');
  maker.setAdminCheat(admin, true, 'chun');
  assert.equal(last(admin, 'admin_cheat').enabled, true);
  assert.notEqual(admin.user.nickname, 'chun', 'adminチートと管理権限は別');
  maker.setCheat(admin, true, 'tomo');
  maker.join(admin, 'online');
  maker.join(rival, 'online');
  const match = admin.match;
  match.games[0].board[14].splice(0, 6, 1, 2, 3, 4, 8, 2);
  clock.value = match.startsAt + CHEAT_INTERVAL_MS - 1;
  maker.tick(40);
  assert.equal(countBoardBlocks(match.games[0]), 6);
  assert.equal(match.games[1].pending, 0);
  clock.value++;
  maker.tick(1);
  assert.equal(countBoardBlocks(match.games[0]), 3);
  assert.equal(match.games[1].pending, 2);
  maker.tick(1);
  assert.equal(countBoardBlocks(match.games[0]), 3);
  clock.value += CHEAT_INTERVAL_MS;
  maker.tick(1);
  assert.equal(countBoardBlocks(match.games[0]), 0);
  assert.equal(match.games[1].pending, 4);
  assert.deepEqual(match.adminCheatSeats, [true, false]);
  assert.ok(fits(match.games[0].board, match.games[0].matrix, match.games[0].x, match.games[0].y));
  await maker.shutdown();
});

test('お邪魔落下中の管理者消去は着地後に実行し、空中ブロックを残さない', () => {
  const game = new Game(1);
  game.board[14].splice(0, 3, 1, 2, 3);
  game.pending = game.garbageRemaining = 1;
  game.garbageActive = true;
  game.tickGarbage(0);
  const target = { ...game.fallingGarbage };
  game.removeBlocks(3);
  assert.equal(game.adminRemovals, 3);
  assert.deepEqual(game.fallingGarbage, target);
  game.tickGarbage(GARBAGE_FALL_MS);
  game.tickGarbage(1);
  assert.equal(game.adminRemovals, 0);
  assert.equal(countBoardBlocks(game), 1);
  for (let x = 0; x < 9; x++)
    for (let y = 0; y < 14; y++) if (game.board[y][x]) assert.ok(game.board[y + 1][x]);
});

test('日中・日またぎの禁止時間を日本時間で判定し、設定を永続化する', async () => {
  const { access, store } = context();
  for (const [schedule, blocked, allowed] of [
    [{ enabled: true, start: '12:00', end: '13:00' }, ['03:00', '03:59'], ['02:59', '04:00']],
    [{ enabled: true, start: '22:00', end: '06:00' }, ['13:00', '20:59'], ['12:59', '21:00']]
  ]) {
    await access.update(schedule);
    for (const time of blocked)
      assert.equal(access.status(Date.parse(`2026-10-25T${time}:00Z`)).blocked, true);
    for (const time of allowed)
      assert.equal(access.status(Date.parse(`2026-10-25T${time}:00Z`)).blocked, false);
    const reloaded = new PlayAccess(store);
    await reloaded.load();
    assert.deepEqual(reloaded.schedule, { ...schedule, paused: false });
  }
  for (const value of [
    { enabled: true, start: '24:00', end: '06:00' },
    { enabled: true, start: '12:00', end: '12:00' },
    { enabled: 'yes', start: '12:00', end: '13:00' }
  ])
    assert.throws(() => access.update(value));
});

test('禁止時間に大会・CPU・通常対戦・待機を終了し、管理者でも新規対戦できない', async () => {
  const { maker, clients, clock, access, last } = context(7);
  maker.tournaments.create(clients[0], 3);
  const room = maker.tournaments.rooms.get(clients[0].room);
  clients.slice(1, 3).forEach((client) => maker.tournaments.join(client, room.code));
  maker.tournaments.start(clients[0]);
  maker.join(clients[3], 'cpu');
  maker.join(clients[4], 'online');
  maker.join(clients[5], 'online');
  maker.join(clients[6], 'online');
  assert.equal(maker.matches.size, 3);
  await maker.setSchedule(clients[3], { enabled: true, start: '12:00', end: '13:00' });
  assert.equal(access.schedule.enabled, false, '権限なしでは設定できない');
  clients[3].user.nickname = 'chun';
  await access.update({ enabled: true, start: '12:01', end: '13:00' });
  clock.value += 60000;
  maker.tick(40);
  assert.equal(maker.matches.size, 0);
  assert.equal(maker.queue.length, 0);
  assert.equal(room.status, 'canceled');
  assert.equal(last(clients[3], 'result').reason, 'restricted');
  maker.join(clients[3], 'cpu');
  assert.equal(clients[3].match, null);
  maker.tournament(clients[6], 'create', { capacity: 3 });
  assert.equal(clients[6].room, null);
  await maker.setSchedule(clients[3], { enabled: false, start: '12:01', end: '13:00' });
  maker.join(clients[3], 'cpu');
  assert.ok(clients[3].match);
  await maker.shutdown();
});

test('chunだけが即時停止・再開でき、全ゲームを止めて再起動後も停止を維持する', async () => {
  const { maker, clients, access, store, last } = context(7);
  const admin = clients[0];
  for (const name of ['参加者1', 'Chun', 'CHUN', 'chun!']) {
    admin.user.nickname = name;
    await maker.setPaused(admin, true);
    assert.equal(access.status().paused, false);
  }
  admin.user.nickname = 'chun';
  maker.tournaments.create(clients[1], 3);
  const room = maker.tournaments.rooms.get(clients[1].room);
  clients.slice(2, 4).forEach((client) => maker.tournaments.join(client, room.code));
  maker.tournaments.start(clients[1]);
  maker.join(admin, 'cpu');
  maker.join(clients[4], 'online');
  maker.join(clients[5], 'online');
  maker.join(clients[6], 'online');
  assert.equal(maker.matches.size, 3);
  await maker.setPaused(admin, true);
  assert.equal(maker.matches.size, 0);
  assert.equal(maker.queue.length, 0);
  assert.equal(room.status, 'canceled');
  assert.equal(last(admin, 'result').reason, 'admin_stop');
  maker.join(admin, 'cpu');
  assert.equal(admin.match, null);
  const restored = new PlayAccess(store);
  await restored.load();
  assert.equal(restored.status().blocked, true);
  assert.equal(restored.status().paused, true);
  admin.user.nickname = '別の名前';
  await maker.setPaused(admin, false);
  await maker.setSchedule(admin, { enabled: false, start: '22:00', end: '06:00' });
  assert.equal(access.status().paused, true, '改名後は管理権限を失う');
  admin.user.nickname = 'chun';
  await maker.setPaused(admin, false);
  maker.join(admin, 'cpu');
  assert.ok(admin.match);
  await maker.shutdown();
});

test('停止状態と時間設定を同時に保存しても失わず、停止解除後も時間制限を守る', async () => {
  const { access, maker, clients, clock } = context();
  clients[0].user.nickname = 'chun';
  await Promise.all([
    access.setPaused(true),
    access.update({ enabled: true, start: '12:00', end: '13:00' })
  ]);
  assert.equal(access.status(clock.value).paused, true);
  assert.equal(access.status(clock.value).enabled, true);
  await maker.setSchedule(clients[0], {
    enabled: true,
    start: '12:00',
    end: '13:00',
    paused: false
  });
  assert.equal(access.status(clock.value).paused, true, '時間設定経由で即時停止を解除しない');
  await maker.setPaused(clients[0], false);
  assert.equal(access.status(clock.value).blocked, true);
  maker.join(clients[0], 'cpu');
  assert.equal(clients[0].match, null);
  clock.value += 3600000;
  maker.join(clients[0], 'cpu');
  assert.ok(clients[0].match);
  assert.throws(() => access.setPaused('false'));
  await maker.shutdown();
});

test('以前の時間設定を読み込んでも停止状態は既定のOFFになる', async () => {
  const { access, store } = context();
  await store.put({
    pk: 'SETTINGS',
    sk: 'PLAY_SCHEDULE',
    enabled: false,
    start: '22:00',
    end: '06:00'
  });
  await access.load();
  assert.equal(access.status().paused, false);
});
