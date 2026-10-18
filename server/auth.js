import { createHash } from 'node:crypto';
export const SESSION_SECONDS = 365 * 24 * 60 * 60;
export const sessionKey = (token) => 'SESSION#' + createHash('sha256').update(token).digest('hex');
export function readToken(req) {
  return /(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
}
export async function resolveUser(store, req) {
  const token = readToken(req);
  if (!token) return null;
  const session = await store.get(sessionKey(token), 'SESSION');
  if (!session || session.ttl <= Date.now() / 1000) return null;
  return store.get('USER#' + session.username, 'PROFILE');
}
export function publicUser(user) {
  return { username: user.username, nickname: user.nickname };
}
