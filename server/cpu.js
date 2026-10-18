import { fits, rotate, clearLines, clearColors, WIDTH, HEIGHT } from '../shared/engine.js';
export const DIFFICULTIES = {
  easy: { delay: 1250, noise: 9 },
  normal: { delay: 700, noise: 2 },
  hard: { delay: 260, noise: 0 }
};

// Evaluate legal placements using holes, aggregate height, roughness and clears.
export function choosePlacement(game, difficulty = 'normal', random = Math.random) {
  const config = DIFFICULTIES[difficulty];
  let matrix = game.matrix,
    best = null;
  for (let turns = 0; turns < 4; turns++, matrix = rotate(matrix)) {
    for (let x = 0; x <= WIDTH - matrix[0].length; x++) {
      if (!fits(game.board, matrix, x, game.y)) continue;
      // Match the server's movement rules: no teleporting through occupied cells.
      let reachable = true;
      for (let sx = game.x; sx !== x; sx += Math.sign(x - game.x))
        if (!fits(game.board, matrix, sx, game.y)) reachable = false;
      if (!reachable) continue;
      let y = game.y;
      while (fits(game.board, matrix, x, y + 1)) y++;
      const board = game.board.map((row) => [...row]);
      matrix.forEach((row, dy) =>
        row.forEach((cell, dx) => {
          if (cell) board[y + dy][x + dx] = cell;
        })
      );
      const cleared = game.rule === 'colors' ? clearColors(board) : clearLines(board);
      const heights = [],
        clean = cleared.board;
      let holes = 0;
      for (let col = 0; col < WIDTH; col++) {
        let top = clean.findIndex((row) => row[col]);
        if (top < 0) top = HEIGHT;
        heights.push(HEIGHT - top);
        for (let row = top; row < HEIGHT; row++) if (!clean[row][col]) holes++;
      }
      const roughness = heights.slice(1).reduce((sum, h, i) => sum + Math.abs(h - heights[i]), 0);
      const value =
        cleared.count * 8 -
        holes * 9 -
        heights.reduce((a, b) => a + b, 0) * 0.5 -
        roughness * 0.7 +
        random() * config.noise;
      if (!best || value > best.value) best = { x, turns, value };
    }
  }
  return best;
}
export function playCpu(game, difficulty) {
  if (game.garbageActive) return;
  if (game.pending >= 3 && game.shield && difficulty !== 'easy') game.action('shield');
  const target = choosePlacement(game, difficulty);
  if (target) {
    for (let i = 0; i < target.turns; i++) game.action('rotate');
    for (let i = 0; i < WIDTH; i++) {
      if (game.x === target.x) break;
      game.action(game.x < target.x ? 'right' : 'left');
    }
  }
  game.action('drop');
}
