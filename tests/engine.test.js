import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Game,
  emptyBoard,
  clearColors,
  fits,
  rotate,
  WIDTH,
  HEIGHT,
  MAX_PENDING_GARBAGE,
  GARBAGE_FALL_MS,
  GARBAGE_GAP_MS,
  GARBAGE_WARNING_MS
} from '../shared/engine.js';
import { playCpu } from '../server/cpu.js';

test('消去は同色4個以上の上下左右のみ。3個・斜め・お邪魔は対象外', () => {
  let board = emptyBoard();
  board[HEIGHT - 1].splice(0, 3, 1, 1, 1);
  assert.equal(clearColors(board).count, 0);
  board[HEIGHT - 2][2] = 1;
  board[HEIGHT - 2][3] = 8;
  const result = clearColors(board);
  assert.equal(result.count, 4);
  assert.equal(result.board.flat().filter(Boolean).length, 0);
  board = emptyBoard();
  for (let i = 0; i < 4; i++) board[HEIGHT - 1 - i][i] = 2;
  assert.equal(clearColors(board).count, 0);
  board = emptyBoard();
  board[HEIGHT - 1].fill(8);
  assert.equal(clearColors(board).count, 0);
});
test('消去後に重力が働き2連鎖する', () => {
  const board = emptyBoard();
  for (const [x, y] of [
    [0, HEIGHT - 1],
    [1, HEIGHT - 1],
    [0, HEIGHT - 2],
    [0, HEIGHT - 3]
  ])
    board[y][x] = 1;
  for (const [x, y] of [
    [1, HEIGHT - 2],
    [1, HEIGHT - 3],
    [0, HEIGHT - 4],
    [0, HEIGHT - 5]
  ])
    board[y][x] = 2;
  const result = clearColors(board);
  assert.equal(result.chains, 2);
  assert.equal(result.count, 8);
  assert.equal(result.board.flat().filter(Boolean).length, 0);
});
test('今置いたブロックと無関係な同色グループは突然まとめて消えない', () => {
  const game = new Game(11);
  game.board[HEIGHT - 1].splice(WIDTH - 4, 4, 2, 2, 2, 2);
  game.matrix = [
    [1, 1],
    [1, 1]
  ];
  game.x = 0;
  game.y = HEIGHT - 2;
  game.lock();
  assert.equal(game.lastClear, 4);
  assert.equal(game.board.flat().filter((cell) => cell === 2).length, 4);
  assert.equal(game.board.flat().filter((cell) => cell === 1).length, 0);
});
test('消去後は全列の内部空洞を詰め、ブロックが盤面内に浮かない', () => {
  const board = emptyBoard();
  board[HEIGHT - 1].splice(0, 2, 1, 1);
  board[HEIGHT - 2].splice(0, 2, 1, 1);
  board[HEIGHT - 1][WIDTH - 1] = 3;
  board[HEIGHT - 3][WIDTH - 1] = 4;

  const result = clearColors(board, [
    [0, HEIGHT - 1],
    [1, HEIGHT - 1],
    [0, HEIGHT - 2],
    [1, HEIGHT - 2]
  ]);

  assert.equal(result.count, 4);
  assert.equal(result.board[HEIGHT - 1][WIDTH - 1], 3);
  assert.equal(result.board[HEIGHT - 2][WIDTH - 1], 4);
  assert.ok(result.board.slice(0, HEIGHT - 2).every((row) => row[WIDTH - 1] === 0));
});
test('隣接お邪魔の消去で動いていない別グループを巻き込まない', () => {
  const board = emptyBoard();
  board[HEIGHT - 2].splice(0, 2, 1, 1);
  board[HEIGHT - 3].splice(0, 2, 1, 1);
  board[HEIGHT - 2][2] = 8;
  board[HEIGHT - 1].splice(2, 4, 2, 2, 2, 2);

  const result = clearColors(board, [
    [0, HEIGHT - 2],
    [1, HEIGHT - 2],
    [0, HEIGHT - 3],
    [1, HEIGHT - 3]
  ]);

  assert.equal(result.count, 4);
  assert.equal(result.chains, 1);
  assert.equal(result.board.flat().filter((cell) => cell === 8).length, 0);
  assert.equal(result.board.flat().filter((cell) => cell === 2).length, 4);
});
test('同じseedは同じブロックを生成し、左右の壁を越えない', () => {
  const a = new Game(42),
    b = new Game(42);
  assert.deepEqual(a.snapshot(), b.snapshot());
  for (let i = 0; i < 30; i++) a.action('left');
  assert.equal(a.x, 0);
  for (let i = 0; i < 30; i++) a.action('right');
  assert.equal(a.x + a.matrix[0].length, WIDTH);
  const original = a.matrix;
  assert.deepEqual(rotate(rotate(rotate(rotate(original)))), original);
  assert.equal(fits(a.board, a.matrix, a.x, HEIGHT), false);
});
test('床際でも上方向のキックで回転し、お邪魔落下中の回転入力も次のブロックへ残る', () => {
  const game = new Game(42);
  game.matrix = [[1, 2, 3, 4]];
  game.x = 3;
  game.y = HEIGHT - 1;
  game.action('rotate');
  assert.equal(game.matrix.length, 4);
  assert.equal(game.y, HEIGHT - 4);

  const next = game.next[0].map((row) => [...row]);
  game.garbageActive = true;
  game.garbageRemaining = 0;
  game.pending = 0;
  game.action('rotate');
  game.tickGarbage(0);
  assert.deepEqual(game.matrix, rotate(next));
  assert.equal(game.bufferedRotations, 0);
});
test('お邪魔を受けても公平なブロック順を維持する', () => {
  const a = new Game(42),
    b = new Game(42);
  a.pending = 2;
  for (const game of [a, b]) {
    game.matrix = [[1]];
    game.x = 0;
    game.y = HEIGHT - 1;
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
  game.y = HEIGHT - 2;
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
  assert.equal(game.pending, 2);
  assert.equal(game.shield, false);
  game.receive(6);
  assert.equal(game.pending, 4);
  game.tick(5000);
  game.receive(2);
  assert.equal(game.pending, 6);
  game.action('shield');
  assert.equal(game.pending, 6);
  assert.equal(game.shieldMs, 0);
});
test('お邪魔の予告と落下は最大6個で、超過分をスタックしない', () => {
  const game = new Game(4);
  game.receive(8);
  game.tick(GARBAGE_WARNING_MS);
  game.matrix = [[1]];
  game.x = WIDTH - 1;
  game.y = HEIGHT - 1;
  game.lock();
  assert.equal(game.garbageActive, true);
  assert.equal(game.pending, 6);
  assert.equal(game.board.flat().filter((c) => c === 8).length, 0);
  assert.ok(game.snapshot().fallingGarbage);
  const pieces = game.pieces;
  game.action('drop');
  assert.equal(game.pieces, pieces);
  game.tick(GARBAGE_FALL_MS - 1);
  assert.equal(game.board.flat().filter((c) => c === 8).length, 0);
  game.tick(1);
  assert.equal(game.board.flat().filter((c) => c === 8).length, 1);
  assert.equal(game.pending, 5);
  game.tick(GARBAGE_GAP_MS - 1);
  assert.equal(game.fallingGarbage, null);
  game.tick(1);
  assert.ok(game.fallingGarbage);
  for (let i = 0; i < 5; i++) {
    game.tick(GARBAGE_FALL_MS);
    game.tick(GARBAGE_GAP_MS);
  }
  assert.equal(game.pending, 0);
  assert.equal(game.board.flat().filter((c) => c === 8).length, 6);
  assert.equal(game.garbageActive, false);
});

test('追加攻撃を受けても落下中を含めてお邪魔スタックは6個まで', () => {
  const game = new Game(4);
  game.receive(4);
  const readyAt = game.garbageReadyAt;
  game.receive(4);
  assert.equal(game.pending, MAX_PENDING_GARBAGE);
  assert.equal(game.garbageReadyAt, readyAt);
  game.tick(GARBAGE_WARNING_MS);
  game.matrix = [[1]];
  game.x = WIDTH - 1;
  game.y = HEIGHT - 1;
  game.lock();
  assert.ok(game.fallingGarbage);
  game.receive(20);
  assert.equal(game.snapshot().pending, MAX_PENDING_GARBAGE);
  game.tick(GARBAGE_FALL_MS);
  assert.equal(game.pending, MAX_PENDING_GARBAGE - 1);
  game.receive(20);
  assert.equal(game.pending, MAX_PENDING_GARBAGE);
  game.action('shield');
  assert.equal(game.pending, MAX_PENDING_GARBAGE - 4);
  game.receive(20);
  assert.equal(game.pending, MAX_PENDING_GARBAGE);
});

test('大きなコンボでも攻撃は最大6個で、予告の相殺を優先する', () => {
  for (const pending of [0, 4, 6]) {
    const game = new Game(1);
    game.receive(pending);
    game.matrix = [
      [1, 1],
      [1, 1]
    ];
    game.x = 0;
    game.y = HEIGHT - 2;
    game.combo = 20;
    let sent = 0;
    game.onAttack = (count) => {
      sent += count;
    };
    game.lock();
    assert.equal(sent, 6 - pending);
    assert.equal(game.pending, 0);
  }
});

test('予告直後の着地ではお邪魔は降らず、消去で相殺できる', () => {
  const game = new Game(3);
  game.receive(1);
  game.matrix = [[2]];
  game.x = WIDTH - 1;
  game.y = HEIGHT - 1;
  game.lock();
  assert.equal(game.garbageActive, false);
  game.matrix = [
    [1, 1],
    [1, 1]
  ];
  game.x = 0;
  game.y = HEIGHT - 2;
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
    game.y = HEIGHT - 1;
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
  assert.equal(game.snapshot().canceled, 1);
  game.tick(249);
  assert.equal(game.snapshot().canceled, 1);
  game.tick(1);
  assert.equal(game.snapshot().canceled, 0);
  assert.deepEqual(game.snapshot().cancellation, expected);
});

test('お邪魔6個の落下待ちは約1.5秒以内に終わる', () => {
  const game = new Game(4);
  game.receive(6);
  game.tick(GARBAGE_WARNING_MS);
  game.matrix = [[1]];
  game.x = WIDTH - 1;
  game.y = HEIGHT - 1;
  game.lock();
  let duration = 0;
  while (game.garbageActive && duration < 5000) {
    game.tick(40);
    duration += 40;
  }
  assert.equal(game.pending, 0);
  assert.equal(game.board.flat().filter((c) => c === 8).length, 6);
  assert.ok(duration <= 1500, `Garbage wave took ${duration}ms`);
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
        g.y = HEIGHT - 1;
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
  game.x = WIDTH - 1;
  game.y = HEIGHT - 1;
  game.lock();
  game.tick(GARBAGE_FALL_MS - 20);
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
  assert.deepEqual(game.board[1], Array(WIDTH).fill(2));
});
test('CPUは全難易度で合法な配置を行う', () => {
  for (const difficulty of ['easy', 'normal', 'hard']) {
    const game = new Game(25);
    for (let i = 0; i < 30 && !game.over; i++) {
      playCpu(game, difficulty);
      assert.equal(game.board.length, HEIGHT);
      assert.ok(game.board.every((row) => row.length === WIDTH));
    }
    assert.ok(game.pieces > 5);
  }
});
