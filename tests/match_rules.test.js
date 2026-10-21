import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHEAT_GARBAGE_COUNT,
  CHEAT_INTERVAL_MS,
  CHEAT_PASSWORD,
  MATCH_DURATION_MS,
  Matchmaker,
  summarizeOpponents
} from '../server/matches.js';
import { Game, GRAVITY_INTERVAL_MS } from '../shared/engine.js';

const createSocket = () => ({
  readyState: 1,
  messages: [],
  send(data) {
    this.messages.push(JSON.parse(data));
  },
  close() {}
});

function createMatch(mode = 'online') {
  const clock = { value: 1_000_000 };
  const store = { put: async () => {} };
  const matchmaker = new Matchmaker(store, { now: () => clock.value });
  const firstSocket = createSocket();
  const first = matchmaker.add({ username: 'first', nickname: 'FIRST' }, firstSocket);
  let second = null;
  let secondSocket = null;
  if (mode === 'online') {
    secondSocket = createSocket();
    second = matchmaker.add({ username: 'second', nickname: 'SECOND' }, secondSocket);
    matchmaker.join(first, 'online');
    matchmaker.join(second, 'online');
  } else matchmaker.join(first, 'cpu', 'normal');
  return { clock, matchmaker, match: first.match, first, second, firstSocket, secondSocket };
}

for (const mode of ['online', 'cpu']) {
  test(`${mode}: 5分経過時はスコアでなく盤面ブロックが少ない側を勝者にする`, async () => {
    const context = createMatch(mode);
    const { clock, matchmaker, match, firstSocket } = context;
    match.games[0].board[14][0] = 1;
    match.games[0].score = 0;
    match.games[1].board[14][0] = 2;
    match.games[1].board[14][1] = 2;
    match.games[1].score = 999_999;

    clock.value = match.startsAt + MATCH_DURATION_MS - 1;
    matchmaker.check(match);
    assert.equal(match.finished, false);

    clock.value++;
    matchmaker.check(match);
    assert.equal(match.finished, true);
    const result = firstSocket.messages.findLast((message) => message.type === 'result');
    assert.equal(result.reason, 'time');
    assert.equal(result.winner, 0);
    assert.deepEqual(result.blockCounts, [1, 2]);
    await Promise.all([...matchmaker.pendingWrites]);
  });
}

test('5分経過時に盤面ブロック数が同じなら引き分けにする', async () => {
  const { clock, matchmaker, match, firstSocket } = createMatch();
  match.games[0].board[14][0] = 1;
  match.games[0].score = 10_000;
  match.games[1].board[14][0] = 2;
  match.games[1].score = 0;
  clock.value = match.startsAt + MATCH_DURATION_MS;
  matchmaker.check(match);
  const result = firstSocket.messages.findLast((message) => message.type === 'result');
  assert.equal(result.winner, null);
  assert.deepEqual(result.blockCounts, [1, 1]);
  await Promise.all([...matchmaker.pendingWrites]);
});

test('正しいパスワードのチートだけが5秒ごとに相手へお邪魔を2個送る', async () => {
  const clock = { value: 2_000_000 };
  const matchmaker = new Matchmaker({ put: async () => {} }, { now: () => clock.value });
  const firstSocket = createSocket();
  const secondSocket = createSocket();
  const first = matchmaker.add({ username: 'first', nickname: 'FIRST' }, firstSocket);
  const second = matchmaker.add({ username: 'second', nickname: 'SECOND' }, secondSocket);

  matchmaker.setCheat(first, true, 'wrong');
  assert.equal(first.cheat, false);
  assert.equal(firstSocket.messages.at(-1).message, 'パスワードが違います。');
  matchmaker.setCheat(first, true, CHEAT_PASSWORD);
  assert.equal(first.cheat, true);

  matchmaker.join(first, 'online');
  matchmaker.join(second, 'online');
  const match = first.match;
  clock.value = match.startsAt + CHEAT_INTERVAL_MS - 1;
  matchmaker.tick(40);
  assert.equal(match.games[1].pending, 0);

  clock.value++;
  matchmaker.tick(1);
  assert.equal(match.games[0].pending, 0);
  assert.equal(match.games[1].pending, CHEAT_GARBAGE_COUNT);

  clock.value = match.startsAt + CHEAT_INTERVAL_MS * 2;
  matchmaker.tick(CHEAT_INTERVAL_MS);
  assert.equal(match.games[1].pending, CHEAT_GARBAGE_COUNT * 2);
  assert.equal(match.events.filter((event) => event.type === 'cheat_attack').length, 2);
  await matchmaker.shutdown();
});

test('時間が経過しても自動落下の間隔は650msから速くならない', () => {
  const game = new Game(42);
  game.elapsed = 10 * 60 * 1000;
  const startY = game.y;
  game.tick(GRAVITY_INTERVAL_MS - 1);
  assert.equal(game.y, startY);
  game.tick(1);
  assert.equal(game.y, startY + 1);
});

test('オンライン対戦履歴を相手ごとに勝率・回数・時間へ集計する', () => {
  const players = [
    { username: 'self', nickname: '自分' },
    { username: 'rival', nickname: '相手' }
  ];
  const summaries = summarizeOpponents(
    [
      {
        startedAt: '2026-10-21T12:00:00.000Z',
        duration: 120_000,
        players,
        winner: 0,
        difficulty: null
      },
      {
        startedAt: '2026-10-20T12:00:00.000Z',
        duration: 60_000,
        players,
        winner: 1,
        difficulty: null
      },
      {
        startedAt: '2026-10-19T12:00:00.000Z',
        duration: 90_000,
        players,
        winner: null,
        difficulty: null
      },
      {
        startedAt: '2026-10-18T12:00:00.000Z',
        duration: 300_000,
        players: [players[0], { username: 'cpu', nickname: 'CPU' }],
        winner: 0,
        difficulty: 'hard'
      }
    ],
    'self'
  );

  assert.equal(summaries.length, 1);
  assert.deepEqual(summaries[0], {
    opponent: { username: 'rival', nickname: '相手' },
    games: 3,
    wins: 1,
    losses: 1,
    draws: 1,
    totalDuration: 270_000,
    latestAt: '2026-10-21T12:00:00.000Z',
    winRate: 1 / 3,
    averageDuration: 90_000
  });
});
