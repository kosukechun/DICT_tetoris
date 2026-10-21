// Pure game rules shared by the authoritative server, renderer and tests.
export const WIDTH = 9;
export const HEIGHT = 15;
export const MAX_GARBAGE = 6;
export const MAX_PENDING_GARBAGE = 6;
export const GARBAGE_WARNING_MS = 1200;
export const GARBAGE_FALL_MS = 150;
export const GARBAGE_GAP_MS = 50;
export const CANCELLATION_FEEDBACK_MS = 250;
// Keep automatic gravity stable for the whole match. Player-controlled soft drop
// remains faster, but elapsed time must never make pieces uncontrollably fast.
export const GRAVITY_INTERVAL_MS = 650;
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
export function clearColors(board, triggerCells = null) {
  board = board.map((row) => [...row]);
  let count = 0,
    chains = 0;
  const targeted = triggerCells !== null;
  let active = targeted ? new Set(triggerCells.map(([x, y]) => y * WIDTH + x)) : null;
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
        if (group.length >= 4 && (!active || group.some(([gx, gy]) => active.has(gy * WIDTH + gx))))
          cleared.push(...group);
      }
    if (!cleared.length) break;
    chains++;
    count += cleared.length;
    const affectedColumns = new Set();
    const garbage = new Set();
    // Adjacent garbage disappears with a color group. Collect it first so the
    // result does not depend on the order in which cleared cells are visited.
    for (const [x, y] of cleared) {
      board[y][x] = 0;
      affectedColumns.add(x);
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1]
      ])
        if (board[ny]?.[nx] === 8) garbage.add(ny * WIDTH + nx);
    }
    for (const key of garbage) {
      const x = key % WIDTH,
        y = Math.floor(key / WIDTH);
      board[y][x] = 0;
      affectedColumns.add(x);
    }

    const moved = new Set();
    // A tetromino can leave supported overhangs in columns that were not part
    // of the clear. Compact every column after a clear so no block remains
    // suspended inside the board. Only blocks that actually moved in a column
    // touched by this clear may trigger the next chain.
    for (let x = 0; x < WIDTH; x++) {
      const column = [];
      for (let y = HEIGHT - 1; y >= 0; y--)
        if (board[y][x]) column.push({ value: board[y][x], oldY: y });
      for (let y = 0; y < HEIGHT; y++) board[y][x] = 0;
      column.forEach(({ value, oldY }, index) => {
        const newY = HEIGHT - 1 - index;
        board[newY][x] = value;
        if (targeted && affectedColumns.has(x) && value !== 8 && oldY !== newY)
          moved.add(newY * WIDTH + x);
      });
    }
    if (targeted) active = moved;
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
    this.cancelSerial = 0;
    this.lastCancellation = null;
    this.shield = true;
    this.shieldMs = 0;
    this.over = false;
    this.elapsed = 0;
    this.gravity = 0;
    this.pieces = 0;
    this.lastClear = 0;
    this.bufferedRotations = 0;
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
    if (!fits(this.board, this.matrix, this.x, this.y)) {
      this.over = true;
      return;
    }
    while (this.bufferedRotations > 0) {
      this.tryRotate();
      this.bufferedRotations--;
    }
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
    if (this.garbageActive && action !== 'shield') {
      if (action === 'rotate') this.bufferedRotations = (this.bufferedRotations + 1) % 4;
      return;
    }
    if (action === 'left') this.move(-1, 0);
    else if (action === 'right') this.move(1, 0);
    else if (action === 'rotate') this.tryRotate();
    else if (action === 'down') {
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
  tryRotate() {
    const rotated = rotate(this.matrix);
    for (const [dx, dy] of [
      [0, 0],
      [-1, 0],
      [1, 0],
      [-2, 0],
      [2, 0],
      [0, -1],
      [-1, -1],
      [1, -1],
      [0, -2],
      [0, -3]
    ])
      if (fits(this.board, rotated, this.x + dx, this.y + dy)) {
        this.matrix = rotated;
        this.x += dx;
        this.y += dy;
        return true;
      }
    return false;
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
    if (this.gravity >= GRAVITY_INTERVAL_MS) {
      this.gravity = 0;
      if (!this.move(0, 1)) this.lock();
    }
  }
  receive(rows) {
    const blocked = this.shieldMs > 0 ? Math.min(rows, 4) : 0;
    if (!this.pending) this.garbageReadyAt = this.elapsed + GARBAGE_WARNING_MS;
    this.pending = Math.min(MAX_PENDING_GARBAGE, this.pending + rows - blocked);
    if (blocked) this.onEvent('blocked', { rows: blocked });
  }
  lock() {
    const lockedCells = [];
    this.matrix.forEach((row, dy) =>
      row.forEach((cell, dx) => {
        if (cell) {
          this.board[this.y + dy][this.x + dx] = cell;
          lockedCells.push([this.x + dx, this.y + dy]);
        }
      })
    );
    const cleared =
      this.rule === 'colors' ? clearColors(this.board, lockedCells) : clearLines(this.board);
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
      let attack = Math.min(
        MAX_GARBAGE,
        (this.rule === 'colors'
          ? Math.floor(cleared.count / 4) + cleared.chains - 1
          : [0, 0, 1, 2, 4][cleared.count]) + Math.floor(this.combo / 2)
      );
      const canceled = Math.min(this.pending, attack);
      this.pending -= canceled;
      attack -= canceled;
      if (canceled) {
        this.lastCanceled = canceled;
        this.canceledUntil = this.elapsed + CANCELLATION_FEEDBACK_MS;
        this.lastCancellation = {
          id: ++this.cancelSerial,
          count: canceled,
          before: this.pending + canceled,
          remaining: this.pending,
          sent: attack
        };
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
        this.garbageRemaining = Math.min(MAX_GARBAGE, this.pending);
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
      cancellation: this.lastCancellation,
      shield: this.shield,
      shieldMs: this.shieldMs,
      over: this.over,
      pieces: this.pieces,
      lastClear: this.lastClear
    };
  }
}
