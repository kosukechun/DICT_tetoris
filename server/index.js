import express from 'express';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createStore } from './store.js';
import { resolveUser, publicUser, sessionKey, readToken, SESSION_SECONDS } from './auth.js';
import { Matchmaker, summarizeOpponents } from './matches.js';

const store = await createStore({ directory: process.env.DATA_DIR || 'data' });
const app = express(),
  server = createServer(app);
const production = process.env.NODE_ENV === 'production';
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));
app.use((req, res, next) => {
  if (req.path !== '/health' && !trustedOrigin(req)) return res.sendStatus(403);
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  });
  if (production) res.set('Strict-Transport-Security', 'max-age=31536000');
  // Same-origin browser mutations only. No CORS exposure.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOrigin(req))
    return res.status(403).json({ error: '同じサイトから操作してください。' });
  next();
});
function trustedOrigin(req) {
  return !process.env.ORIGIN_SECRET || req.headers['x-origin-verify'] === process.env.ORIGIN_SECRET;
}
function sameOrigin(req) {
  if (!req.headers.origin) return !production;
  try {
    return new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
}
app.use(express.json({ limit: '8kb' }));
const limits = new Map();
function rateLimit(req, res, next) {
  const key = req.ip,
    now = Date.now();
  let item = limits.get(key);
  if (!item || item.until < now) {
    item = { count: 0, until: now + 60000 };
    limits.set(key, item);
  }
  if (++item.count > 20)
    return res.status(429).json({ error: '操作が多すぎます。1分後にお試しください。' });
  next();
}
const cleanup = setInterval(() => {
  for (const [key, item] of limits) if (item.until < Date.now()) limits.delete(key);
}, 60000);
cleanup.unref();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
const setSessionCookie = (res, token, maxAge = SESSION_SECONDS * 1000) =>
  res.cookie('session', token, {
    httpOnly: true,
    secure: production,
    sameSite: 'strict',
    maxAge,
    path: '/'
  });
async function signIn(res, user, previousToken) {
  const token = randomBytes(32).toString('hex');
  await store.put({
    pk: sessionKey(token),
    sk: 'SESSION',
    username: user.username,
    ttl: Math.floor(Date.now() / 1000) + SESSION_SECONDS
  });
  setSessionCookie(res, token);
  if (previousToken) await store.remove(sessionKey(previousToken), 'SESSION');
  res.json({ user: publicUser(user) });
}
app.post(
  '/api/register',
  rateLimit,
  wrap(async (req, res) => {
    const { nickname } = req.body;
    if (typeof nickname !== 'string' || !nickname.trim() || nickname.trim().length > 16)
      return res.status(400).json({
        error: '名前は1〜16文字で入力してください。'
      });
    const existing = await resolveUser(store, req);
    const username = existing?.username || randomUUID();
    const client = existing && matchmaker.clients.get(username);
    if (client?.match || client?.queued)
      return res.status(409).json({ error: '対戦・待機を終了してから名前を変更してください。' });
    const user = {
      ...existing,
      pk: 'USER#' + username,
      sk: 'PROFILE',
      username,
      nickname: nickname.trim(),
      createdAt: existing?.createdAt || new Date().toISOString()
    };
    await store.put(user);
    if (client) client.user = user;
    await signIn(res, user, readToken(req));
  })
);
app.post(
  '/api/logout',
  wrap(async (req, res) => {
    const token = readToken(req),
      user = await resolveUser(store, req);
    if (token) await store.remove(sessionKey(token), 'SESSION');
    if (user) matchmaker.clients.get(user.username)?.ws.close(1000, 'Logged out');
    setSessionCookie(res, '', 0);
    res.json({ ok: true });
  })
);
app.get(
  '/api/me',
  wrap(async (req, res) => {
    const user = await resolveUser(store, req);
    res.json({ user: user ? publicUser(user) : null });
  })
);
app.get(
  '/api/history',
  wrap(async (req, res) => {
    const user = await resolveUser(store, req);
    if (!user) return res.status(401).json({ error: '名前を登録してください。' });
    const allMatches = await store.list('USER#' + user.username, 'MATCH#', null);
    res.json({
      matches: allMatches.slice(0, 20).map(({ pk, sk, ...match }) => match),
      opponentStats: summarizeOpponents(allMatches, user.username)
    });
  })
);
app.use('/shared', express.static(fileURLToPath(new URL('../shared', import.meta.url))));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
app.use((error, req, res, next) => {
  console.error(JSON.stringify({ event: 'request_error', message: error.message }));
  res
    .status(error.status === 400 || error.status === 413 ? error.status : 500)
    .json({ error: '処理に失敗しました。しばらくしてから再試行してください。' });
});
const matchmaker = new Matchmaker(store);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws' || !sameOrigin(req) || !trustedOrigin(req) || stopping) {
    socket.destroy();
    return;
  }
  const timer = setTimeout(() => socket.destroy(), 5000);
  resolveUser(store, req)
    .then((user) => {
      clearTimeout(timer);
      if (socket.destroyed) return;
      if (!user || matchmaker.clients.has(user.username)) {
        socket.write('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const client = matchmaker.add(user, ws);
        if (!client) {
          ws.close(1008, 'Duplicate session');
          return;
        }
        ws.alive = true;
        ws.on('pong', () => {
          ws.alive = true;
        });
        let count = 0,
          window = Date.now();
        ws.on('message', (data) => {
          if (Date.now() - window > 1000) {
            window = Date.now();
            count = 0;
          }
          if (++count > 45) {
            ws.close(1008, 'Rate limit');
            return;
          }
          try {
            const message = JSON.parse(data.toString());
            if (message.type === 'join') matchmaker.join(client, message.mode, message.difficulty);
            else if (message.type === 'cheat')
              matchmaker.setCheat(client, message.enabled !== false, message.password);
            else if (message.type === 'cancel') {
              matchmaker.unqueue(client);
              matchmaker.send(client, 'canceled');
            } else if (
              message.type === 'action' &&
              ['left', 'right', 'down', 'rotate', 'drop', 'shield', 'forfeit'].includes(
                message.action
              )
            )
              matchmaker.action(client, message.action);
          } catch {
            matchmaker.send(client, 'error', { message: '送信内容を確認してください。' });
          }
        });
        ws.on('close', () => matchmaker.remove(client));
        ws.on('error', () => {});
        matchmaker.send(client, 'ready');
      });
    })
    .catch((error) => {
      clearTimeout(timer);
      console.error(JSON.stringify({ event: 'upgrade_error', message: error.message }));
      socket.destroy();
    });
});
let stopping = false;
const tick = setInterval(() => matchmaker.tick(40), 40);
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) ws.terminate();
    else {
      ws.alive = false;
      ws.ping();
    }
  }
}, 20000);
const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () =>
  console.log(`DAIKIN DICT F9 テトリス http://localhost:${port}`)
);
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(tick);
  clearInterval(heartbeat);
  clearInterval(cleanup);
  const timeout = setTimeout(() => process.exit(1), 10000);
  timeout.unref();
  await matchmaker.shutdown();
  wss.close();
  server.close(() => {
    clearTimeout(timeout);
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
