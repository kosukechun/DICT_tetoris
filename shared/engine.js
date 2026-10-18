// Pure game rules shared by the authoritative server, renderer and tests.
export const WIDTH = 10;
export const HEIGHT = 20;
export const GARBAGE_WARNING_MS = 1200;
export const GARBAGE_FALL_MS = 480;
export const GARBAGE_GAP_MS = 240;
export const SHAPES = [
  [[1, 1, 1, 1]],
  [
    [2, 2],
    [2, 2]
  ],
  [
    [0, 3, 0],
    [3, 3, 3]
  ],
  [
    [0, 4, 4],
    [4, 4, 0]
  ],
  [
    [5, 5, 0],
    [0, 5, 5]
  ],
  [
    [6, 0, 0],
    [6, 6, 6]
  ],
  [
    [0, 0, 7],
    [7, 7, 7]
  ]
];
export const emptyBoard = () => Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(0));
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function rotate(matrix) {
  return matrix[0].map((_, x) => matrix.map((row) => row[x]).reverse());
}
export function fits(board, matrix, x, y) {
  return matrix.every((row, dy) =>
    row.every(
      (cell, dx) =>
        !cell ||
        (x + dx >= 0 && x + dx < WIDTH && y + dy < HEIGHT && (y + dy < 0 || !board[y + dy][x + dx]))
    )
  );
}
export function clearLines(board) {
  const remaining = board.filter((row) => row.some((cell) => !cell));
  const count = HEIGHT - remaining.length;
  return {
    board: [...Array.from({ length: count }, () => Array(WIDTH).fill(0)), ...remaining],
    count,
    chains: count ? 1 : 0
  };
}
export function clearColors(board) {
  board = board.map((row) => [...row]);
  let count = 0,
    chains = 0;
  while (true) {
    const seen = new Set(),
      cleared = [];
    for (let y = 0; y < HEIGHT; y++)
      for (let x = 0; x < WIDTH; x++) {
        const color = board[y][x],
          key = y * WIDTH + x;
        if (!color || color === 8 || seen.has(key)) continue;
        const group = [[x, y]];
        seen.add(key);
        for (let i = 0; i < group.length; i++) {
          const [cx, cy] = group[i];
          for (const [nx, ny] of [
            [cx - 1, cy],
            [cx + 1, cy],
            [cx, cy - 1],
            [cx, cy + 1]
          ]) {
            const k = ny * WIDTH + nx;
            if (
              nx >= 0 &&
              nx < WIDTH &&
              ny >= 0 &&
              ny < HEIGHT &&
              !seen.has(k) &&
              board[ny][nx] === color
            ) {
              seen.add(k);
              group.push([nx, ny]);
            }
          }
        }
        if (group.length >= 4) cleared.push(...group);
      }
    if (!cleared.length) break;
    chains++;
    count += cleared.length;
    // Adjacent garbage disappears with a color group.
    for (const [x, y] of cleared) {
      board[y][x] = 0;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1]
      ])
        if (board[ny]?.[nx] === 8) board[ny][nx] = 0;
    }
    for (let x = 0; x < WIDTH; x++) {
      const column = board.map((row) => row[x]).filter(Boolean);
      for (let y = HEIGHT - 1; y >= 0; y--) board[y][x] = column.pop() || 0;
    }
  }
  return { board, count, chains };
}
export class Game {
  constructor(seed = 1, rule = 'colors') {
    this.random = seededRandom(seed);
    this.garbageRandom = seededRandom(seed ^ 0x9e3779b9);
    this.rule = rule;
    this.board = emptyBoard();
    this.bag = [];
    this.next = [];
    this.score = 0;
    this.lines = 0;
    this.combo = -1;
    this.pending = 0;
    this.garbageReadyAt = 0;
    this.garbageActive = false;
    this.garbageRemaining = 0;
    this.garbageClock = 0;
    this.fallingGarbage = null;
    this.lastCanceled = 0;
    this.canceledUntil = 0;
    this.shield = true;
    this.shieldMs = 0;
    this.over = false;
    this.elapsed = 0;
    this.gravity = 0;
    this.pieces = 0;
    this.lastClear = 0;
    this.onAttack = () => {};
    this.onEvent = () => {};
    for (let i = 0; i < 4; i++) this.next.push(this.draw());
    this.spawn();
  }
  draw() {
    if (!this.bag.length) {
      this.bag = [0, 1, 2, 3, 4, 5, 6];
      for (let i = 6; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
      }
    }
    const shape = SHAPES[this.bag.pop()].map((row) => [...row]);
    return this.rule === 'colors'
      ? shape.map((row) => row.map((cell) => (cell ? 1 + Math.floor(this.random() * 4) : 0)))
      : shape;
  }
  spawn() {
    this.matrix = this.next.shift();
    this.next.push(this.draw());
    this.x = Math.floor((WIDTH - this.matrix[0].length) / 2);
    this.y = 0;
    this.gravity = 0;
    if (!fits(this.board, this.matrix, this.x, this.y)) this.over = true;
  }
  move(dx, dy) {
    if (fits(this.board, this.matrix, this.x + dx, this.y + dy)) {
      this.x += dx;
      this.y += dy;
      return true;
    }
    return false;
  }
  action(action) {
    if (this.over) return;
    if (this.garbageActive && action !== 'shield') return;
    if (action === 'left') this.move(-1, 0);
    else if (action === 'right') this.move(1, 0);
    else if (action === 'rotate') {
      const rotated = rotate(this.matrix);
      for (const offset of [0, -1, 1, -2, 2])
        if (fits(this.board, rotated, this.x + offset, this.y)) {
          this.matrix = rotated;
          this.x += offset;
          break;
        }
    } else if (action === 'down') {
      if (this.move(0, 1)) this.score++;
      else this.lock();
    } else if (action === 'drop') {
      while (this.move(0, 1)) this.score += 2;
      this.lock();
    } else if (action === 'shield' && this.shield) {
      this.shield = false;
      this.shieldMs = 5000;
      const blocked = Math.min(4, this.pending);
      this.pending -= blocked;
      this.garbageRemaining = Math.min(this.garbageRemaining, this.pending);
      if (!this.pending) this.fallingGarbage = null;
      this.onEvent('shield', { blocked });
    }
  }
  tick(ms) {
    if (this.over) return;
    this.elapsed += ms;
    this.shieldMs = Math.max(0, this.shieldMs - ms);
    if (this.garbageActive) {
      this.tickGarbage(ms);
      return;
    }
    this.gravity += ms;
    const speed = Math.max(130, 800 - Math.floor(this.elapsed / 30000) * 65);
    if (this.gravity >= speed) {
      this.gravity = 0;
      if (!this.move(0, 1)) this.lock();
    }
  }
  receive(rows) {
    const blocked = this.shieldMs > 0 ? Math.min(rows, 4) : 0;
    if (!this.pending) this.garbageReadyAt = this.elapsed + GARBAGE_WARNING_MS;
    this.pending = Math.min(20, this.pending + rows - blocked);
    if (blocked) this.onEvent('blocked', { rows: blocked });
  }
  lock() {
    this.matrix.forEach((row, dy) =>
      row.forEach((cell, dx) => {
        if (cell) this.board[this.y + dy][this.x + dx] = cell;
      })
    );
    const cleared = this.rule === 'colors' ? clearColors(this.board) : clearLines(this.board);
    this.board = cleared.board;
    this.lastClear = cleared.count;
    this.pieces++;
    if (cleared.count) {
      this.combo++;
      this.lines += cleared.count;
      this.score +=
        (this.rule === 'colors'
          ? cleared.count * 50 * cleared.chains
          : [0, 100, 300, 500, 800][cleared.count]) +
        this.combo * 100;
      let attack =
        (this.rule === 'colors'
          ? Math.floor(cleared.count / 4) + cleared.chains - 1
          : [0, 0, 1, 2, 4][cleared.count]) + Math.floor(this.combo / 2);
      const canceled = Math.min(this.pending, attack);
      this.pending -= canceled;
      attack -= canceled;
      if (canceled) {
        this.lastCanceled = canceled;
        this.canceledUntil = this.elapsed + 1400;
        this.onEvent('cancel', { count: canceled });
      }
      this.onEvent('clear', {
        count: cleared.count,
        chains: cleared.chains,
        combo: this.combo,
        attack,
        canceled
      });
      if (attack) this.onAttack(attack);
    } else {
      this.combo = -1;
      if (this.pending && this.elapsed >= this.garbageReadyAt) {
        this.garbageActive = true;
        this.garbageRemaining = Math.min(6, this.pending);
        this.garbageClock = 0;
        this.tickGarbage(0);
        return;
      }
    }
    this.spawn();
  }
  tickGarbage(ms) {
    // One visible block at a time. Pending includes the airborne block until landing.
    if (!this.pending || !this.garbageRemaining) {
      this.fallingGarbage = null;
      this.garbageActive = false;
      this.spawn();
      return;
    }
    if (this.fallingGarbage) {
      this.fallingGarbage.elapsed += ms;
      if (this.fallingGarbage.elapsed < GARBAGE_FALL_MS) return;
      const { x, targetY } = this.fallingGarbage;
      this.board[targetY][x] = 8;
      this.pending--;
      this.garbageRemaining--;
      this.fallingGarbage = null;
      this.garbageClock = GARBAGE_GAP_MS;
      this.onEvent('garbage', { count: 1, x, y: targetY });
      if (targetY === 0) this.over = true;
      return;
    }
    this.garbageClock -= ms;
    if (this.garbageClock > 0) return;
    const columns = Array.from({ length: WIDTH }, (_, x) => x).filter((x) => !this.board[0][x]);
    if (!columns.length) {
      this.over = true;
      return;
    }
    const x = columns[Math.floor(this.garbageRandom() * columns.length)];
    const top = this.board.findIndex((row) => row[x]);
    this.fallingGarbage = { x, targetY: top < 0 ? HEIGHT - 1 : top - 1, elapsed: 0 };
  }
  snapshot() {
    return {
      board: this.board,
      matrix: this.garbageActive ? [] : this.matrix,
      x: this.x,
      y: this.y,
      next: this.next.slice(0, 3),
      score: this.score,
      lines: this.lines,
      combo: this.combo,
      pending: this.pending,
      fallingGarbage: this.fallingGarbage ? { ...this.fallingGarbage } : null,
      garbageActive: this.garbageActive,
      canceled: this.elapsed < this.canceledUntil ? this.lastCanceled : 0,
      shield: this.shield,
      shieldMs: this.shieldMs,
      over: this.over,
      pieces: this.pieces,
      lastClear: this.lastClear
    };
  }
}
