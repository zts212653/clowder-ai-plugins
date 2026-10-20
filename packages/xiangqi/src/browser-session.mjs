import { randomBytes, timingSafeEqual } from 'node:crypto';

const equal = (left, right) => typeof left === 'string' && /^[a-f0-9]{64}$/.test(left) &&
  timingSafeEqual(Buffer.from(left), Buffer.from(right));

/** The launch bearer is delivered only through a Host-authenticated owner browser request. */
export function createBrowserSession() {
  const session = randomBytes(32).toString('hex');
  const launches = new Map();
  return {
    launch() {
      const now = Date.now();
      for (const [key, expiry] of launches) if (expiry < now) launches.delete(key);
      if (launches.size >= 16) throw new Error('请使用已经打开的棋盘');
      const secret = randomBytes(32).toString('hex');
      launches.set(secret, now + 600_000);
      return secret;
    },
    handle(req, res) {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/api/session' && req.method === 'POST') {
        const key = req.headers.authorization?.replace(/^Bearer /, '');
        const expires = launches.get(key);
        if (!req.headers.origin || !expires || expires < Date.now()) {
          res.writeHead(403); res.end(); return true;
        }
        launches.delete(key);
        res.writeHead(200, { 'content-type': 'application/json',
          'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        res.end(JSON.stringify({ session })); return true;
      }
      if (!path.startsWith('/api/')) return false;
      const value = req.headers.authorization?.replace(/^Bearer /, '');
      if (!equal(value, session)) {
        res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: '请从原对话重新打开这盘棋' })); return true;
      }
      return false;
    },
  };
}
