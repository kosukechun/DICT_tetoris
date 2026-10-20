import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Game,
  emptyBoard,
  GARBAGE_FALL_MS,
  GARBAGE_GAP_MS,
  GARBAGE_WARNING_MS,
  HEIGHT,
  WIDTH
} from '../shared/engine.js';

test('オンライン相当の2盤面を仮想10分動かして回転・消去・お邪魔を検証する', () => {
  const games = [new Game(20261019), new Game(20261019)];
  const clears = [[], []];
  games.forEach((game, seat) => {
    game.onAttack = (count) => games[1 - seat].receive(count);
    game.onEvent = (type, details) => {
      if (type === 'clear') clears[seat].push(details.count);
    };
  });

  const settleGarbage = (game) => {
    let waited = 0;
    while (game.garbageActive && !game.over) {
      game.tick(10);
      waited += 10;
      assert.ok(waited <= 6 * (GARBAGE_FALL_MS + GARBAGE_GAP_MS) + 100);
    }
  };

  for (let second = 0; second < 10 * 60; second++) {
    const order = second % 2 ? [1, 0] : [0, 1];
    for (const seat of order) {
      const game = games[seat];
      const before = game.matrix.map((row) => [...row]);
      game.action('rotate');
      assert.equal(game.matrix.flat().filter(Boolean).length, before.flat().filter(Boolean).length);

      game.board = emptyBoard();
      game.matrix = [
        [seat + 1, seat + 1],
        [seat + 1, seat + 1]
      ];
      game.x = 0;
      game.y = HEIGHT - 2;
      game.lock();
      assert.equal(game.lastClear, 4);
      assert.equal(game.board.flat().filter(Boolean).length, 0);
      assert.equal(game.board.length, HEIGHT);
      assert.ok(game.board.every((row) => row.length === WIDTH));
    }

    if (second > 0 && second % 30 === 0) {
      for (const game of games) {
        game.board = emptyBoard();
        game.pending = 0;
        game.garbageActive = false;
        game.fallingGarbage = null;
        game.receive(6);
        game.tick(GARBAGE_WARNING_MS);
        game.matrix = [[3]];
        game.x = WIDTH - 1;
        game.y = HEIGHT - 1;
        game.lock();
        settleGarbage(game);
        assert.equal(game.pending, 0);
        assert.equal(game.board.flat().filter((cell) => cell === 8).length, 6);
        game.board = emptyBoard();
      }
    }

    games.forEach((game) => game.tick(1000));
    assert.ok(games.every((game) => !game.over));
  }

  assert.deepEqual(
    clears.map((events) => events.length),
    [600, 600]
  );
  assert.ok(clears.flat().every((count) => count === 4));
  assert.ok(games.every((game) => game.elapsed >= 10 * 60 * 1000));
});
