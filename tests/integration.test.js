import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createStore } from '../server/store.js';
import { rotate } from '../shared/engine.js';
const base = 'http://127.0.0.1:3197';

function inbox(ws) {
  const messages = [],
    waiters = [];
  ws.on('message', (data) => {
    const message = JSON.parse(data);
    const index = waiters.findIndex((w) => w.type === message.type);
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
    } else messages.push(message);
  });
  return (type) => {
    const index = messages.findIndex((m) => m.type === type);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        type,
        resolve,
        timeout: setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error('Timed out: ' + type));
        }, 7000)
      };
      waiters.push(waiter);
    });
  };
}
test('名前登録・同時対戦・勝敗・ログの再起動後永続化', { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dict-f9-'));
  let child;
  async function start() {
    child = spawn(process.execPath, ['server/index.js'], {
      env: {
        ...process.env,
        PORT: '3197',
        DATA_DIR: directory,
        NODE_ENV: 'test',
        DYNAMODB_TABLE: ''
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let errors = '';
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    for (let i = 0; i < 70; i++) {
      try {
        if ((await fetch(base + '/health')).ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Server did not start: ' + errors);
  }
  async function stop() {
    const done = once(child, 'exit');
    child.kill();
    await done;
  }
  const sockets = [];
  t.after(async () => {
    sockets.forEach((ws) => ws.terminate());
    if (child?.exitCode === null) await stop();
    await rm(directory, { recursive: true, force: true });
  });
  await start();
  const post = (endpoint, body, cookie, origin = base) =>
    fetch(base + '/api/' + endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {})
      },
      body: JSON.stringify(body)
    });
  const register = async (username) => {
    const response = await post('register', {
      nickname: 'テスト ' + username
    });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('set-cookie').includes('HttpOnly'));
    return response.headers.get('set-cookie').split(';')[0];
  };
  const a = await register('alice'),
    b = await register('bob');
  assert.equal((await post('logout', {}, a, 'https://evil.example')).status, 403);
  assert.equal((await fetch(base + '/api/history')).status, 401);
  const open = async (cookie) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws', {
      headers: { Cookie: cookie, Origin: base }
    });
    sockets.push(ws);
    const next = inbox(ws);
    await next('ready');
    return { ws, next, send: (message) => ws.send(JSON.stringify(message)) };
  };
  const one = await open(a),
    two = await open(b);
  one.send({ type: 'join', mode: 'online' });
  await one.next('queued');
  two.send({ type: 'join', mode: 'online' });
  const first = await one.next('start'),
    second = await two.next('start');
  assert.equal(first.id, second.id);
  assert.notEqual(first.seat, second.seat);
  const initialState = await one.next('state');
  assert.equal(initialState.states.length, 2);
  await new Promise((resolve) => setTimeout(resolve, 3100));
  const expectedRotation = rotate(initialState.states[first.seat].matrix);
  one.send({ type: 'action', action: 'rotate' });
  let rotationReceived = false;
  for (let i = 0; i < 60; i++) {
    const state = await one.next('state');
    if (JSON.stringify(state.states[first.seat].matrix) === JSON.stringify(expectedRotation)) {
      rotationReceived = true;
      break;
    }
  }
  assert.equal(rotationReceived, true, 'online rotation was not reflected by the server');
  one.send({ type: 'action', action: 'forfeit' });
  const result = await one.next('result');
  assert.equal(result.winner, second.seat);
  assert.equal(result.reason, 'forfeit');
  await one.next('saved');
  await two.next('saved');
  const readHistory = (cookie) =>
    fetch(base + '/api/history', { headers: { Cookie: cookie } }).then((response) =>
      response.json()
    );
  assert.equal((await readHistory(a)).matches[0].id, first.id);
  assert.equal((await readHistory(b)).matches.length, 1);
  one.send({ type: 'join', mode: 'cpu', difficulty: 'hard' });
  const cpu = await one.next('start');
  assert.equal(cpu.difficulty, 'hard');
  one.ws.close();
  await once(one.ws, 'close');
  two.ws.close();
  await once(two.ws, 'close');
  // Wait for async log writes before terminating the process on Windows.
  for (let i = 0; i < 30; i++) {
    if ((await readHistory(a)).matches.length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await stop();
  await start();
  const persisted = (await readHistory(a)).matches;
  assert.equal(persisted.length, 2);
  assert.ok(persisted.some((match) => match.id === first.id));
  const store = await createStore({ directory });
  const me = await fetch(base + '/api/me', { headers: { Cookie: a } }).then((r) => r.json());
  const player = await store.get('USER#' + me.user.username, 'PROFILE');
  assert.equal(player.nickname, 'テスト alice');
  assert.equal(player.passwordHash, undefined);
});
