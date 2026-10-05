import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { safeId } from './worker-state.mjs';

const execute = promisify(execFile);
const REQUEST_TIMEOUT_MS = 30_000;
const CLI_VERSION = '1.0.4';

async function loadInstalledRuntime() {
  const { stdout } = await execute('npm', ['root', '-g'], { timeout: REQUEST_TIMEOUT_MS });
  const root = resolve(stdout.trim(), '@masumi_network/sokosumi');
  const metadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  if (metadata.version !== CLI_VERSION) throw new Error('Recheck runtime authentication against the installed Sokosumi CLI version.');
  const [{ createCoworkerHttpClient }, { readRuntimeCredential }] = await Promise.all([
    import(pathToFileURL(resolve(root, 'dist/src/api/http-client.js')).href),
    import(pathToFileURL(resolve(root, 'dist/src/coworker/runtime-credentials.js')).href),
  ]);
  return { createCoworkerHttpClient, readRuntimeCredential };
}

// Use the CLI's runtime authentication path. Never return or log the vault key.
export async function createCoreRuntime(coworkerId, userId, { loadRuntime = loadInstalledRuntime } = {}) {
  safeId(coworkerId);
  if (userId !== undefined) safeId(userId);
  const { createCoworkerHttpClient, readRuntimeCredential } = await loadRuntime();
  // Payment events require the Coworker actor. User context changes the Core actor to a user.
  const client = createCoworkerHttpClient({ apiKey: readRuntimeCredential(coworkerId) });
  const identity = await client.get('/v1/coworkers/me', AbortSignal.timeout(REQUEST_TIMEOUT_MS));
  if (identity.data?.id !== coworkerId || identity.data.archivedAt !== null || !identity.data.capabilities?.includes('tasks')) {
    throw new Error('Coworker runtime identity does not match this demo.');
  }
  return scopeCoreRuntime(client);
}

export function scopeCoreRuntime(client) {
  return {
    async get(path, signal) {
      if (!/^\/v1\/tasks\/[A-Za-z0-9_-]+\/receipt$/.test(path)) throw new Error('Unsupported Core receipt route.');
      try { return await client.get(path, signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)); }
      catch { throw new Error('Core receipt could not be read. Inspect the existing payment before retrying.'); }
    },
    async task(taskId) {
      safeId(taskId);
      try { return (await client.get(`/v1/tasks/${taskId}`, AbortSignal.timeout(REQUEST_TIMEOUT_MS))).data; }
      catch { throw new Error('Comment Task could not be inspected.'); }
    },
    async events(taskId) {
      safeId(taskId);
      const events = [];
      const cursors = new Set();
      let cursor;
      try {
        do {
          const query = new URLSearchParams({ limit: '100' });
          if (cursor) query.set('cursor', cursor);
          const page = await client.get(`/v1/tasks/${taskId}/events?${query}`, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
          if (!Array.isArray(page.data) || !page.meta?.pagination ||
              page.data.some(event => event.taskId !== taskId)) throw new Error('Invalid event page.');
          events.push(...page.data);
          cursor = page.meta.pagination.nextCursor;
          if (cursor !== null) {
            if (typeof cursor !== 'string') throw new Error('Missing event cursor.');
            safeId(cursor);
            if (cursors.has(cursor)) throw new Error('Repeated event cursor.');
            cursors.add(cursor);
          }
        } while (cursor != null);
        return events;
      } catch { throw new Error('Comment events could not be read completely.'); }
    },
    async comment(taskId, comment, coworkerId) {
      safeId(taskId); safeId(coworkerId);
      if (typeof comment !== 'string' || !comment.trim() || Buffer.byteLength(comment) > 1_048_576) {
        throw new Error('Invalid comment reply.');
      }
      try {
        const event = (await client.post(`/v1/tasks/${taskId}/events`, { comment }, AbortSignal.timeout(REQUEST_TIMEOUT_MS))).data;
        if (!event?.id || event.taskId !== taskId || event.actor?.type !== 'coworker' ||
            event.actor.id !== coworkerId || event.comment !== comment) throw new Error('Unconfirmed comment.');
        return safeId(event.id);
      } catch { throw new Error('Comment post outcome is uncertain. Inspect Task events before retrying.'); }
    },
    async payment(taskId, event) {
      safeId(taskId);
      try {
        const result = await client.post(`/v1/tasks/${taskId}/events`, event, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
        if (!result.data?.id) throw new Error('Missing payment event confirmation.');
        return result.data.id;
      } catch { throw new Error('Core payment event outcome is uncertain. Inspect the Task before retrying.'); }
    },
  };
}
