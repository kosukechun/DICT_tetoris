import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Game,
  emptyBoard,
  clearColors,
  fits,
  rotate,
  GARBAGE_FALL_MS,
  GARBAGE_GAP_MS,
  GARBAGE_WARNING_MS
} from '../shared/engine.js';
import { playCpu } from '../server/cpu.js';

test('消去は同色4個以上の上下左右のみ。3個・斜め・お邪魔は対象外', () => {
  let board = emptyBoard();
  board[19].splice(0, 3, 1, 1, 1);
  assert.equal(clearColors(board).count, 0);
  board[18][2] = 1;
  board[18][3] = 8;
  const result = clearColors(board);
  assert.equal(result.count, 4);
  assert.equal(result.board.flat().filter(Boolean).length, 0);
  board = emptyBoard();
  for (let i = 0; i < 4; i++) board[19 - i][i] = 2;
  assert.equal(clearColors(board).count, 0);
  board = emptyBoard();
  board[19].fill(8);
  assert.equal(clearColors(board).count, 0);
});
test('消去後に重力が働き2連鎖する', () => {
  const board = emptyBoard();
  for (const [x, y] of [
    [0, 19],
    [1, 19],
    [0, 18],
    [0, 17]
  ])
    board[y][x] = 1;
  for (const [x, y] of [
    [1, 18],
    [1, 17],
    [0, 16],
    [0, 15]
  ])
    board[y][x] = 2;
  const result = clearColors(board);
  assert.equal(result.chains, 2);
  assert.equal(result.count, 8);
  assert.equal(result.board.flat().filter(Boolean).length, 0);
});
test('同じseedは同じブロックを生成し、左右の壁を越えない', () => {
  const a = new Game(42),
    b = new Game(42);
  assert.deepEqual(a.snapshot(), b.snapshot());
  for (let i = 0; i < 30; i++) a.action('left');
  assert.equal(a.x, 0);
  for (let i = 0; i < 30; i++) a.action('right');
  assert.equal(a.x + a.matrix[0].length, 10);
  const original = a.matrix;
  assert.deepEqual(rotate(rotate(rotate(rotate(original)))), original);
  assert.equal(fits(a.board, a.matrix, a.x, 20), false);
});
test('お邪魔を受けても公平なブロック順を維持する', () => {
  const a = new Game(42),
    b = new Game(42);
  a.pending = 2;
  for (const game of [a, b]) {
    game.matrix = [[1]];
    game.x = 0;
    game.y = 19;
    game.lock();
  }
  while (a.garbageActive && !a.over) a.tick(40);
  assert.deepEqual(a.next, b.next);
  assert.deepEqual(a.matrix, b.matrix);
});
test('消去の攻撃は待機中のお邪魔を先に相殺する', () => {
  const game = new Game(1);
  game.board = emptyBoard();
  game.matrix = [
    [1, 1],
    [1, 1]
  ];
  game.x = 0;
  game.y = 18;
  game.pending = 2;
  let sent = 0;
  game.onAttack = (rows) => {
    sent += rows;
  };
  game.lock();
  assert.equal(game.lines, 4);
  assert.equal(game.pending, 1);
  assert.equal(sent, 0);
  assert.ok(game.score >= 200);
});
test('シールドは1回のみ。最大4個の相殺と5秒の防御', () => {
  const game = new Game(1);
  game.receive(7);
  game.action('shield');
  assert.equal(game.pending, 3);
  assert.equal(game.shield, false);
  game.receive(6);
  assert.equal(game.pending, 5);
  game.tick(5000);
  game.receive(2);
  assert.equal(game.pending, 7);
  game.action('shield');
  assert.equal(game.pending, 7);
  assert.equal(game.shieldMs, 0);
});
test('お邪魔は予告後に上から1個ずつ落ち、1回最大6個', () => {
  const game = new Game(4);
  game.receive(8);
  game.tick(GARBAGE_WARNING_MS);
  game.matrix = [[1]];
  game.x = 9;
  game.y = 19;
  game.lock();
  assert.equal(game.garbageActive, true);
  assert.equal(game.pending, 8);
  assert.equal(game.board.flat().filter((c) => c === 8).length, 0);
  assert.ok(game.snapshot().fallingGarbage);
  const pieces = game.pieces;
  game.action('drop');
  assert.equal(game.pieces, pieces);
  game.tick(GARBAGE_FALL_MS - 1);
  assert.equal(game.board.flat().filter((c) => c === 8).length, 0);
  game.tick(1);
  assert.equal(game.board.flat().filter((c) => c === 8).length, 1);
  assert.equal(game.pending, 7);
  game.tick(GARBAGE_GAP_MS - 1);
  assert.equal(game.fallingGarbage, null);
  game.tick(1);
  assert.ok(game.fallingGarbage);
  for (let i = 0; i < 5; i++) {
    game.tick(GARBAGE_FALL_MS);
    game.tick(GARBAGE_GAP_MS);
  }
  assert.equal(game.pending, 2);
  assert.equal(game.board.flat().filter((c) => c === 8).length, 6);
  assert.equal(game.garbageActive, false);
});

test('予告直後の着地ではお邪魔は降らず、消去で相殺できる', () => {
  const game = new Game(3);
  game.receive(1);
  game.matrix = [[2]];
  game.x = 9;
  game.y = 19;
  game.lock();
  assert.equal(game.garbageActive, false);
  game.matrix = [
    [1, 1],
    [1, 1]
  ];
  game.x = 0;
  game.y = 18;
  game.lock();
  assert.equal(game.pending, 0);
  assert.equal(game.snapshot().canceled, 1);
  assert.deepEqual(game.snapshot().cancellation, {
    id: 1,
    count: 1,
    before: 1,
    remaining: 0,
    sent: 0
  });
});

test('相殺通知は連続消去でも識別でき、残り予告と送り返した数を記録する', () => {
  const game = new Game(7);
  game.receive(3);
  const clear = () => {
    game.matrix = [Array(8).fill(1)];
    game.x = 0;
    game.y = 19;
    game.lock();
  };
  clear();
  assert.deepEqual(game.snapshot().cancellation, {
    id: 1,
    count: 2,
    before: 3,
    remaining: 1,
    sent: 0
  });
  clear();
  const expected = { id: 2, count: 1, before: 1, remaining: 0, sent: 1 };
  assert.deepEqual(game.snapshot().cancellation, expected);
  game.tick(3000);
  assert.equal(game.snapshot().canceled, 0);
  assert.deepEqual(game.snapshot().cancellation, expected);
});

test('お邪魔6個の落下待ちは約2.2秒以内に終わる', () => {
  const game = new Game(4);
  game.receive(6);
  game.tick(GARBAGE_WARNING_MS);
  game.matrix = [[1]];
  game.x = 9;
  game.y = 19;
  game.lock();
  let duration = 0;
  while (game.garbageActive && duration < 5000) {
    game.tick(40);
    duration += 40;
  }
  assert.equal(game.pending, 0);
  assert.equal(game.board.flat().filter((c) => c === 8).length, 6);
  assert.ok(duration <= 2200, `Garbage wave took ${duration}ms`);
});

test('両者の攻撃は順序にかかわらず相殺され、差分だけが残る', () => {
  for (const order of [
    [0, 1],
    [1, 0]
  ]) {
    for (const counts of [
      [4, 4],
      [8, 4]
    ]) {
      const games = [new Game(7), new Game(7)];
      games.forEach((g, i) => {
        g.onAttack = (n) => games[1 - i].receive(n);
        g.matrix = [Array(counts[i]).fill(1)];
        g.x = 0;
        g.y = 19;
      });
      order.forEach((i) => games[i].lock());
      assert.equal(games[0].pending, 0);
      assert.equal(games[1].pending, counts[0] === 8 ? 1 : 0);
    }
  }
});

test('落下中のシールドで最後のお邪魔を消すと盤面には残らない', () => {
  const game = new Game(5);
  game.receive(1);
  game.tick(GARBAGE_WARNING_MS);
  game.matrix = [[1]];
  game.x = 9;
  game.y = 19;
  game.lock();
  game.tick(200);
  game.action('shield');
  game.tick(GARBAGE_FALL_MS);
  assert.equal(game.garbageActive, false);
  assert.equal(game.board.flat().filter((c) => c === 8).length, 0);
});

test('お邪魔が天井に届くと負ける。既存の盤面は押し上げない', () => {
  const game = new Game(1);
  game.board[1].fill(2);
  game.pending = 1;
  game.garbageActive = true;
  game.garbageRemaining = 1;
  game.tick(0);
  game.tick(GARBAGE_FALL_MS);
  assert.equal(game.over, true);
  assert.deepEqual(game.board[1], Array(10).fill(2));
});
test('CPUは全難易度で合法な配置を行う', () => {
  for (const difficulty of ['easy', 'normal', 'hard']) {
    const game = new Game(25);
    for (let i = 0; i < 30 && !game.over; i++) {
      playCpu(game, difficulty);
      assert.equal(game.board.length, 20);
      assert.ok(game.board.every((row) => row.length === 10));
    }
    assert.ok(game.pieces > 5);
  }
});
