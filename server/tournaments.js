import { randomBytes, randomInt } from 'node:crypto';

export class Tournaments {
  constructor(matchmaker) {
    this.matchmaker = matchmaker;
    this.rooms = new Map();
  }
  error(client, message) {
    this.matchmaker.send(client, 'error', { message });
  }
  create(client, capacity) {
    if (!Number.isInteger(capacity) || capacity < 3 || capacity > 8)
      return this.error(client, '参加人数は3〜8人で指定してください。');
    if (client.room || client.match || client.queued)
      return this.error(client, '現在の対戦・待機・部屋を終了してください。');
    this.cleanup();
    if (this.rooms.size >= 100) return this.error(client, '部屋が混み合っています。');
    let code;
    do {
      code = randomBytes(3).toString('hex').toUpperCase();
    } while (this.rooms.has(code));
    const room = {
      code,
      capacity,
      host: client.user.username,
      status: 'lobby',
      members: [{ ...client.user, connected: true }],
      rounds: [],
      ready: new Set(),
      createdAt: this.matchmaker.now(),
      champion: null
    };
    this.rooms.set(code, room);
    client.room = code;
    this.broadcast(room);
  }
  join(client, code) {
    if (client.room || client.match || client.queued)
      return this.error(client, '現在の対戦・待機・部屋を終了してください。');
    const room = typeof code === 'string' && this.rooms.get(code.trim().toUpperCase());
    if (!room || room.status !== 'lobby')
      return this.error(client, '参加できる部屋が見つかりません。');
    if (room.members.length >= room.capacity) return this.error(client, '部屋が満員です。');
    room.members.push({ ...client.user, connected: true });
    client.room = room.code;
    this.broadcast(room);
  }
  start(client) {
    const room = this.rooms.get(client.room);
    if (!room || room.host !== client.user.username || room.status !== 'lobby')
      return this.error(client, '主催者だけが大会を開始できます。');
    if (room.members.length !== room.capacity)
      return this.error(client, '設定した人数が集まるまでお待ちください。');
    const players = room.members.map(({ username, nickname }) => ({ username, nickname }));
    for (let i = players.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [players[i], players[j]] = [players[j], players[i]];
    }
    room.status = 'running';
    room.ready = new Set(players.map((player) => player.username));
    const size = 2 ** Math.ceil(Math.log2(players.length));
    const byes = size - players.length;
    const pairs = players.slice(0, byes).map((player) => [player, null]);
    for (let i = byes; i < players.length; i += 2) pairs.push([players[i], players[i + 1]]);
    this.addRound(room, pairs);
    this.advance(room);
  }
  addRound(room, pairs) {
    room.rounds.push(
      pairs.map((players, index) => ({
        id: `${room.rounds.length + 1}-${index + 1}`,
        players,
        status: 'waiting',
        winner: null,
        matchId: null,
        reason: null
      }))
    );
  }
  connected(room, player) {
    const client = player && this.matchmaker.clients.get(player.username);
    return client?.room === room.code && client.ws.readyState === 1 ? client : null;
  }
  advance(room) {
    if (room.status !== 'running') return;
    const round = room.rounds.at(-1);
    for (const entry of round) {
      if (entry.status !== 'waiting') continue;
      const clients = entry.players.map((player) => this.connected(room, player));
      if (!clients[0] || !clients[1]) {
        entry.status = 'done';
        entry.winner = clients[0] ? entry.players[0] : clients[1] ? entry.players[1] : null;
        entry.reason = entry.players.includes(null) ? 'bye' : 'disconnect';
      } else if (entry.players.every((player) => room.ready.has(player.username))) {
        entry.status = 'playing';
        entry.players.forEach((player) => room.ready.delete(player.username));
        const match = this.matchmaker.start(clients, null, { code: room.code, entry: entry.id });
        entry.matchId = match.id;
      }
    }
    if (round.every((entry) => entry.status === 'done')) {
      const winners = round.map((entry) => entry.winner);
      if (winners.length === 1) {
        room.champion = winners[0];
        room.status = winners[0] ? 'finished' : 'canceled';
      } else {
        const pairs = [];
        for (let i = 0; i < winners.length; i += 2) pairs.push([winners[i], winners[i + 1]]);
        this.addRound(room, pairs);
        this.advance(room);
        return;
      }
    }
    this.broadcast(room);
  }
  ready(client) {
    const room = this.rooms.get(client.room);
    if (!room || room.status !== 'running' || client.match) return;
    const waiting = room.rounds
      .at(-1)
      .some(
        (entry) =>
          entry.status === 'waiting' &&
          entry.players.some((player) => player?.username === client.user.username)
      );
    if (!waiting) return;
    room.ready.add(client.user.username);
    this.advance(room);
  }
  result(match, winner, reason) {
    const room = this.rooms.get(match.tournament?.code);
    if (!room || room.status !== 'running') return;
    const entry = room.rounds.flat().find((item) => item.matchId === match.id);
    if (!entry) return;
    entry.reason = reason;
    if (winner === null) {
      entry.status = 'waiting';
      entry.matchId = null;
      entry.reason = 'draw';
    } else {
      entry.status = 'done';
      entry.winner = entry.players[winner];
    }
    this.advance(room);
  }
  leave(client, reason = 'forfeit') {
    const room = this.rooms.get(client.room);
    if (!room) return;
    client.room = null;
    room.ready.delete(client.user.username);
    if (room.status === 'lobby') {
      room.members = room.members.filter((member) => member.username !== client.user.username);
      if (room.host === client.user.username) room.host = room.members[0]?.username;
    } else {
      const member = room.members.find((item) => item.username === client.user.username);
      if (member) member.connected = false;
    }
    this.matchmaker.send(client, 'tournament_left');
    if (client.match) this.matchmaker.finish(client.match, 1 - client.seat, reason);
    if (!room.members.some((member) => this.connected(room, member))) this.rooms.delete(room.code);
    else if (room.status === 'running') this.advance(room);
    else this.broadcast(room);
  }
  snapshot(room, client) {
    return {
      code: room.code,
      capacity: room.capacity,
      host: room.host,
      status: room.status,
      members: room.members.map(({ username, nickname, connected }) => ({
        username,
        nickname,
        connected
      })),
      rounds: room.rounds,
      champion: room.champion,
      ready: [...room.ready],
      canReady:
        room.status === 'running' &&
        !client.match &&
        room.rounds
          .at(-1)
          .some(
            (entry) =>
              entry.status === 'waiting' &&
              entry.players.some((player) => player?.username === client.user.username)
          )
    };
  }
  broadcast(room) {
    for (const member of room.members) {
      const client = this.connected(room, member);
      if (client) this.matchmaker.send(client, 'tournament', { room: this.snapshot(room, client) });
    }
  }
  cancelAll() {
    for (const room of this.rooms.values()) {
      if (!['lobby', 'running'].includes(room.status)) continue;
      room.status = 'canceled';
      this.broadcast(room);
    }
  }
  cleanup() {
    for (const [code, room] of this.rooms)
      if (!room.members.some((member) => this.connected(room, member))) this.rooms.delete(code);
  }
}
