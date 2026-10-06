import { Client } from 'eve/client';

// Loopback eve server; the shared password is only needed when the server runs without `eve dev`.
export function createEveClient(env = process.env) {
  const password = env.EVE_INTERNAL_PASSWORD;
  return new Client({ host: env.EVE_URL || 'http://127.0.0.1:2000', redirect: 'error', ...(password ? { auth: { basic: { username: 'worker', password } } } : {}) });
}
