import { randomUUID, randomInt } from 'node:crypto';
import { Game } from '../shared/engine.js';
import { DIFFICULTIES, playCpu } from './cpu.js';
export const MATCH_DURATION_MS = 5 * 60 * 1000;
export const CHEAT_INTERVAL_MS = 5 * 1000;
export const CHEAT_GARBAGE_COUNT = 2;
export const CHEAT_PASSWORD = 'tomo';

export const countBoardBlocks = (game) =>
  game.board.reduce(
    (total, row) => total + row.reduce((rowTotal, cell) => rowTotal + Number(Boolean(cell)), 0),
    0
  );

export class Matchmaker {
  constructor(store, { now = () => Date.now() } = {}) {
    this.store = store;
    this.now = now;
    this.clients = new Map();
    this.queue = [];
    this.matches = new Map();
    this.pendingWrites = new Set();
  }
  send(client, type, payload = {}) {
    if (client.ws.readyState === 1) client.ws.send(JSON.stringify({ type, ...payload }));
  }
  add(user, ws) {
    if (this.clients.has(user.username)) return null;
    const client = { user, ws, match: null, queued: false, cheat: false };
    this.clients.set(user.username, client);
    return client;
  }
  unqueue(client) {
    this.queue = this.queue.filter((c) => c !== client);
    client.queued = false;
  }
  remove(client) {
    this.unqueue(client);
    if (client.match) this.finish(client.match, 1 - client.seat, 'disconnect');
    this.clients.delete(client.user.username);
  }
  setCheat(client, enabled, password = '') {
    if (client.match || client.queued) {
      this.send(client, 'cheat', {
        enabled: client.cheat,
        message: '対戦・待機を終了してから切り替えてください。'
      });
      return;
    }
    if (!enabled) client.cheat = false;
    else if (password === CHEAT_PASSWORD) client.cheat = true;
    else {
      client.cheat = false;
      this.send(client, 'cheat', { enabled: false, message: 'パスワードが違います。' });
      return;
    }
    this.send(client, 'cheat', { enabled: client.cheat });
  }
  join(client, mode, difficulty = 'normal') {
    if (client.match || client.queued) return;
    if (mode === 'cpu') {
      if (!DIFFICULTIES[difficulty]) return;
      this.start([client, null], difficulty);
    } else if (mode === 'online') {
      const opponent = this.queue.shift();
      if (opponent) {
        opponent.queued = false;
        this.start([opponent, client], null);
      } else {
        client.queued = true;
        this.queue.push(client);
        this.send(client, 'queued');
      }
    }
  }
  start(clients, difficulty) {
    const seed = randomInt(0x7fffffff),
      id = randomUUID(),
      now = this.now();
    const match = {
      id,
      clients,
      difficulty,
      games: [new Game(seed, 'colors'), new Game(seed, 'colors')],
      startedAt: now,
      startsAt: now + 3000,
      events: [],
      droppedEvents: 0,
      finished: false,
      cpuClock: 0,
      lastBroadcast: 0,
      cheatSeats: clients.map((client) => Boolean(client?.cheat)),
      cheatWaves: [0, 0]
    };
    match.players = clients.map((c) =>
      c
        ? { username: c.user.username, nickname: c.user.nickname }
        : { username: 'cpu', nickname: `CPU · ${difficulty.toUpperCase()}` }
    );
    const record = (type, details) => {
      if (match.events.length < 1500)
        match.events.push({ at: this.now() - match.startedAt, type, ...details });
      else match.droppedEvents++;
    };
    match.record = record;
    match.games.forEach((game, seat) => {
      game.onEvent = (type, details) => record(type, { seat, ...details });
      game.onAttack = (rows) => {
        match.games[1 - seat].receive(rows);
        record('attack', { seat, rows });
      };
    });
    clients.forEach((client, seat) => {
      if (!client) return;
      client.match = match;
      client.seat = seat;
      this.send(client, 'start', {
        id,
        seat,
        players: match.players,
        startsAt: match.startsAt,
        serverNow: this.now(),
        difficulty,
        cheatEnabled: match.cheatSeats[seat]
      });
    });
    this.matches.set(id, match);
    this.broadcast(match);
  }
  action(client, action) {
    const match = client.match;
    if (!match || match.finished) return;
    if (action === 'forfeit') {
      this.finish(match, 1 - client.seat, 'forfeit');
      return;
    }
    if (this.now() < match.startsAt) return;
    match.games[client.seat].action(action);
    this.check(match);
  }
  check(match) {
    const [a, b] = match.games;
    if (a.over || b.over) this.finish(match, a.over && b.over ? null : a.over ? 1 : 0, 'topout');
    else if (this.now() - match.startsAt >= MATCH_DURATION_MS) {
      const blocks = match.games.map(countBoardBlocks);
      this.finish(match, blocks[0] === blocks[1] ? null : blocks[0] < blocks[1] ? 0 : 1, 'time');
    }
  }
  tick(ms) {
    for (const match of this.matches.values()) {
      const now = this.now();
      if (now >= match.startsAt) {
        match.games.forEach((game) => game.tick(ms));
        if (match.difficulty && !match.games[1].over) {
          match.cpuClock += ms;
          if (match.cpuClock >= DIFFICULTIES[match.difficulty].delay) {
            match.cpuClock = 0;
            playCpu(match.games[1], match.difficulty);
          }
        }
        const dueWaves = Math.floor((now - match.startsAt) / CHEAT_INTERVAL_MS);
        match.cheatSeats.forEach((enabled, seat) => {
          if (!enabled) return;
          while (match.cheatWaves[seat] < dueWaves) {
            match.cheatWaves[seat]++;
            match.games[1 - seat].receive(CHEAT_GARBAGE_COUNT);
            match.record('cheat_attack', { seat, rows: CHEAT_GARBAGE_COUNT });
          }
        });
        this.check(match);
      }
      if (!match.finished && now - match.lastBroadcast >= 80) this.broadcast(match);
    }
  }
  broadcast(match) {
    match.lastBroadcast = this.now();
    const states = match.games.map((game) => game.snapshot());
    for (const client of match.clients)
      if (client)
        this.send(client, 'state', { states, elapsed: Math.max(0, this.now() - match.startsAt) });
  }
  finish(match, winner, reason) {
    if (match.finished) return;
    match.finished = true;
    this.broadcast(match);
    this.matches.delete(match.id);
    const record = {
      id: match.id,
      startedAt: new Date(match.startedAt).toISOString(),
      duration: Math.max(0, this.now() - match.startsAt),
      players: match.players,
      scores: match.games.map((g) => g.score),
      blockCounts: match.games.map(countBoardBlocks),
      winner,
      reason,
      difficulty: match.difficulty,
      cheats: match.cheatSeats,
      events: match.events,
      droppedEvents: match.droppedEvents
    };
    for (const client of match.clients)
      if (client) {
        client.match = null;
        this.send(client, 'result', { ...record, events: undefined, saved: false });
      }
    const write = this.persist(match, record).finally(() => this.pendingWrites.delete(write));
    this.pendingWrites.add(write);
  }
  async persist(match, record) {
    try {
      await Promise.all(
        match.clients.filter(Boolean).map((client) =>
          this.store.put({
            pk: 'USER#' + client.user.username,
            sk: `MATCH#${record.startedAt}#${record.id}`,
            ...record
          })
        )
      );
      for (const client of match.clients) if (client) this.send(client, 'saved', { id: match.id });
      console.log(
        JSON.stringify({
          event: 'match_finished',
          id: match.id,
          reason: record.reason,
          duration: record.duration
        })
      );
    } catch (error) {
      console.error(
        JSON.stringify({ event: 'match_save_failed', id: match.id, error: error.message })
      );
      for (const client of match.clients)
        if (client)
          this.send(client, 'error', {
            message: '対戦ログの保存に失敗しました。管理者にお問い合わせください。'
          });
    }
  }
  async shutdown() {
    for (const match of [...this.matches.values()]) this.finish(match, null, 'server_shutdown');
    await Promise.all([...this.pendingWrites]);
    for (const client of this.clients.values()) client.ws.close(1001, 'Server restarting');
  }
}
