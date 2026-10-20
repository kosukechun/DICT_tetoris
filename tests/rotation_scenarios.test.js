import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, SHAPES, WIDTH, HEIGHT, emptyBoard, fits, rotate } from '../shared/engine.js';
import { playCpu } from '../server/cpu.js';
import { Matchmaker } from '../server/matches.js';

const shapeNames = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
const clone = (matrix) => matrix.map((row) => [...row]);

function rotationGame(shapeIndex, x, y) {
  const game = new Game(100 + shapeIndex, 'classic');
  game.board = emptyBoard();
  game.matrix = clone(SHAPES[shapeIndex]);
  game.x = x;
  game.y = y;
  game.over = false;
  return game;
}

for (const [shapeIndex, shapeName] of shapeNames.entries()) {
  test(`回転 ${shapeName}-中央: 4回転で元の形へ戻る`, () => {
    const shape = SHAPES[shapeIndex];
    const game = rotationGame(shapeIndex, Math.floor((WIDTH - shape[0].length) / 2), 3);
    for (let turn = 0; turn < 4; turn++) assert.equal(game.tryRotate(), true);
    assert.deepEqual(game.matrix, shape);
    assert.equal(fits(game.board, game.matrix, game.x, game.y), true);
  });

  test(`回転 ${shapeName}-左壁: 壁を越えず回転できる`, () => {
    const game = rotationGame(shapeIndex, 0, 2);
    assert.equal(game.tryRotate(), true);
    assert.equal(fits(game.board, game.matrix, game.x, game.y), true);
    assert.ok(game.x >= 0);
  });

  test(`回転 ${shapeName}-右壁: キック後も盤面内に収まる`, () => {
    const shape = SHAPES[shapeIndex];
    const game = rotationGame(shapeIndex, WIDTH - shape[0].length, 2);
    assert.equal(game.tryRotate(), true);
    assert.equal(fits(game.board, game.matrix, game.x, game.y), true);
    assert.ok(game.x + game.matrix[0].length <= WIDTH);
  });

  test(`回転 ${shapeName}-床: 上方向キックで盤面内に収まる`, () => {
    const shape = SHAPES[shapeIndex];
    const game = rotationGame(
      shapeIndex,
      Math.floor((WIDTH - shape[0].length) / 2),
      HEIGHT - shape.length
    );
    assert.equal(game.tryRotate(), true);
    assert.equal(fits(game.board, game.matrix, game.x, game.y), true);
    assert.ok(game.y + game.matrix.length <= HEIGHT);
  });
}

test('回転-全候補が障害物: 盤面とブロックを変更しない', () => {
  const game = rotationGame(2, 2, 4);
  game.board = Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(8));
  const before = clone(game.matrix);
  assert.equal(game.tryRotate(), false);
  assert.deepEqual(game.matrix, before);
  assert.deepEqual([game.x, game.y], [2, 4]);
});

for (const count of [1, 2, 3, 4]) {
  test(`回転予約-${count}回: お邪魔終了後の次ブロックへ正確に反映する`, () => {
    const game = new Game(300 + count);
    let expected = clone(game.next[0]);
    game.garbageActive = true;
    game.garbageRemaining = 0;
    game.pending = 0;
    for (let turn = 0; turn < count; turn++) {
      game.action('rotate');
      expected = rotate(expected);
    }
    game.tickGarbage(0);
    assert.deepEqual(game.matrix, expected);
    assert.equal(game.bufferedRotations, 0);
    assert.equal(fits(game.board, game.matrix, game.x, game.y), true);
  });
}

for (const difficulty of ['easy', 'normal', 'hard']) {
  test(`CPU ${difficulty}: 9×15盤面でも回転後に不正配置しない`, () => {
    const game = new Game(500, 'colors');
    for (let piece = 0; piece < 40 && !game.over; piece++) {
      playCpu(game, difficulty);
      assert.equal(game.board.length, HEIGHT);
      assert.ok(game.board.every((row) => row.length === WIDTH));
      assert.ok(
        game.board.flat().every((cell) => Number.isInteger(cell) && cell >= 0 && cell <= 8)
      );
      assert.ok(game.x >= 0 && game.x + game.matrix[0].length <= WIDTH);
    }
    assert.ok(game.pieces > 0);
  });
}

function onlineMatch() {
  const matchmaker = new Matchmaker({ put: async () => {} });
  const makeClient = (name) =>
    matchmaker.add(
      { username: name, nickname: name },
      { readyState: 1, send: () => {}, close: () => {} }
    );
  const first = makeClient('first');
  const second = makeClient('second');
  matchmaker.join(first, 'online');
  matchmaker.join(second, 'online');
  const match = first.match;
  match.startsAt = Date.now() - 1;
  return { matchmaker, match, clients: [first, second] };
}

for (const seat of [0, 1]) {
  test(`オンライン席${seat + 1}: WebSocket相当の回転操作を自分の盤面だけへ反映する`, () => {
    const { matchmaker, match, clients } = onlineMatch();
    const ownBefore = clone(match.games[seat].matrix);
    const rivalBefore = clone(match.games[1 - seat].matrix);
    matchmaker.action(clients[seat], 'rotate');
    assert.deepEqual(match.games[seat].matrix, rotate(ownBefore));
    assert.deepEqual(match.games[1 - seat].matrix, rivalBefore);
  });
}

test('オンライン両席: 同時回転しても互いの盤面や状態を破壊しない', () => {
  const { matchmaker, match, clients } = onlineMatch();
  const before = match.games.map((game) => clone(game.matrix));
  matchmaker.action(clients[0], 'rotate');
  matchmaker.action(clients[1], 'rotate');
  assert.deepEqual(match.games[0].matrix, rotate(before[0]));
  assert.deepEqual(match.games[1].matrix, rotate(before[1]));
  assert.ok(match.games.every((game) => !game.over));
});

test('オンラインお邪魔中: 回転入力を捨てず自分の次ブロックだけへ予約する', () => {
  const { matchmaker, match, clients } = onlineMatch();
  match.games[0].garbageActive = true;
  match.games[0].garbageRemaining = 1;
  match.games[0].pending = 1;
  matchmaker.action(clients[0], 'rotate');
  assert.equal(match.games[0].bufferedRotations, 1);
  assert.equal(match.games[1].bufferedRotations, 0);
});
