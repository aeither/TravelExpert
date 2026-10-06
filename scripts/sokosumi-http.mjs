import { safeId } from './worker-state.mjs';

const API = 'https://api.preprod.sokosumi.com';
const TIMEOUT_MS = 30_000;
const RESULT_LIMIT = 1_048_576;

// HTTP client for the Coworker runtime key. Same get/post shape as the Sokosumi CLI's client: parsed JSON, throws on any non-2xx.
export function createHttpClient(apiKey, send = fetch) {
  if (typeof apiKey !== 'string' || !apiKey.startsWith('coworker_') || /\s/.test(apiKey)) throw new Error('Missing or invalid Coworker runtime key.');
  const call = async (method, path, body, signal) => {
    const response = await send(`${API}${path}`, {
      method, redirect: 'error', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Sokosumi HTTP ${response.status}`);
    return response.json();
  };
  return { get: (path, signal) => call('GET', path, undefined, signal), post: (path, body, signal) => call('POST', path, body, signal) };
}

// Same contract as the CLI-backed runtime in worker.mjs: list READY tasks, inspect, start, complete.
export function httpRuntime(coworkerId, client) {
  safeId(coworkerId);
  const events = async id => {
    const all = []; const seen = new Set(); let cursor;
    do {
      const query = new URLSearchParams({ limit: '100' }); if (cursor) query.set('cursor', cursor);
      const page = await client.get(`/v1/tasks/${safeId(id)}/events?${query}`);
      if (!Array.isArray(page.data)) throw new Error('Invalid event page.');
      all.push(...page.data);
      cursor = page.meta?.pagination?.nextCursor ?? null;
      if (cursor) { safeId(cursor); if (seen.has(cursor)) throw new Error('Repeated event cursor.'); seen.add(cursor); }
    } while (cursor);
    return all;
  };
  return {
    async list() {
      const page = await client.get(`/v1/tasks?${new URLSearchParams({ coworkerId, status: 'READY', limit: '100' })}`);
      if (!Array.isArray(page.data)) throw new Error('Invalid Task list response.');
      return page.data.filter(task => task.status === 'READY' && (task.assigneeId ?? task.coworkerId) === coworkerId);
    },
    async inspect(id) { return { task: (await client.get(`/v1/tasks/${safeId(id)}`)).data, events: await events(id) }; },
    async start(id) {
      const event = (await client.post(`/v1/tasks/${safeId(id)}/events`, { status: 'RUNNING' })).data;
      if (event?.status !== 'RUNNING' || !event.id) throw new Error('Start event was not confirmed.');
      return (await client.get(`/v1/tasks/${id}`)).data;
    },
    async complete(id, _resultFile, resultText) {
      if (typeof resultText !== 'string' || !resultText.trim() || Buffer.byteLength(resultText) > RESULT_LIMIT) throw new Error('Invalid result text.');
      const event = (await client.post(`/v1/tasks/${safeId(id)}/events`, { status: 'COMPLETED', comment: resultText })).data;
      return { status: event?.status, taskId: event?.taskId, eventId: event?.id };
    },
  };
}
