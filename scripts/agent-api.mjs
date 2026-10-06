import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createEveClient } from './eve-client.mjs';
import { createChat, streamEvents } from './chat.mjs';

export const API_DIRECTORY = resolve(process.env.DATA_DIR || resolve(import.meta.dirname, '../.local'), 'agent-api');
const BODY_LIMIT = 65_536;
const RESULT_LIMIT = 1_048_576;
const idSchema = z.string().uuid();
const startSchema = z.object({
  // This demo follows the live MPS purchaser-nonce restriction, narrower than MIP003's generic string.
  identifier_from_purchaser: z.string().regex(/^[0-9a-f]{14,26}$/),
  input_data: z.object({ request: z.string().min(1).max(BODY_LIMIT) }).strict(),
}).strict();
const quoteSchema = z.object({
  id: idSchema,
  blockchainIdentifier: z.string().min(1),
  payByTime: z.number().int().positive(),
  submitResultTime: z.number().int().positive(),
  unlockTime: z.number().int().positive(),
  externalDisputeUnlockTime: z.number().int().positive(),
  agentIdentifier: z.string().min(1),
  sellerVKey: z.string().min(1),
  identifierFromPurchaser: z.string().min(1),
  input_hash: z.string().min(1),
}).strict();

export const inputSchema = {
  input_data: [{ id: 'request', type: 'string', name: 'Trip request',
    data: { description: 'A plain-language trip request. Example: "Plan 3 days in Cebu from 9 November for 2 people". The destination and arrival date are required.' },
    validations: [{ validation: 'min', value: '1' }, { validation: 'max', value: String(BODY_LIMIT) }] }],
};

function apiError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

export function parseStart(body) {
  try {
    const parsed = startSchema.parse(body);
    const request = parsed.input_data.request.trim();
    if (!request) throw new Error('Empty request.');
    return { body: parsed, request };
  } catch { throw apiError(400, 'Invalid input_data.request or identifier_from_purchaser (14 to 26 lowercase hexadecimal characters required).'); }
}

// Hashes here address local journals only. Masumi hashes come exclusively from the payment adapter.
const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');

export async function createJobManager({ directory = API_DIRECTORY, dependencies = {} } = {}) {
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  let lock;
  try { lock = await open(resolve(root, 'owner.lock'), 'wx', 0o600); }
  catch { throw new Error('Agent API journal has an owner lock. Inspect the process before removing it.'); }
  await lock.writeFile(String(process.pid));
  let tail = Promise.resolve();
  let closed = false;
  const serial = action => {
    const next = tail.then(() => { if (closed) throw apiError(503, 'Agent API is stopping.'); return action(); });
    tail = next.catch(() => {});
    return next;
  };
  const file = id => resolve(root, `${idSchema.parse(id)}.json`);
  const syncDirectory = async () => { const directoryHandle = await open(root, 'r'); try { await directoryHandle.sync(); } finally { await directoryHandle.close(); } };
  const durableWrite = async (path, value) => {
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
  };
  const save = async job => {
    const temporary = `${file(job.id)}.${randomUUID()}.tmp`;
    await durableWrite(temporary, JSON.stringify(job, null, 2) + '\n');
    await rename(temporary, file(job.id));
    await syncDirectory();
  };
  const load = async id => {
    try { return JSON.parse(await readFile(file(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw apiError(404, 'Job not found.'); throw apiError(400, 'Invalid or unreadable job.'); }
  };
  // After process loss, uncertain model and payment writes need operator reconciliation.
  for (const name of await readdir(root)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const job = await load(name.slice(0, -5));
    if (!['awaiting-payment', 'completed'].includes(job.stage) && !job.inspectionRequired) {
      job.inspectionRequired = true; job.status = 'failed'; await save(job);
    }
  }
  const availability = async () => {
    try {
      return !closed && dependencies.registrationVerified === true &&
        ['quote', 'fundsLocked', 'runAgent', 'submitResult', 'modelHealth'].every(name => typeof dependencies[name] === 'function') &&
        await dependencies.modelHealth() === true;
    } catch { return false; }
  };
  return {
    availability,
    async listAwaiting() {
      return serial(async () => {
        const ids = [];
        for (const name of await readdir(root)) {
          if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
          const job = await load(name.slice(0, -5));
          if (job.stage === 'awaiting-payment' && !job.inspectionRequired) ids.push(job.id);
        }
        return ids.sort();
      });
    },
    async start(raw) {
      const { body, request } = parseStart(raw);
      return serial(async () => {
        const noncePath = resolve(root, `nonce-${digest(body.identifier_from_purchaser)}.json`);
        const fingerprint = digest(JSON.stringify(body.input_data));
        let prior;
        try { prior = JSON.parse(await readFile(noncePath, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw apiError(503, 'Purchaser journal requires inspection.'); }
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw apiError(409, 'Purchaser identifier already belongs to a different input.');
          const job = await load(prior.id);
          if (job.inspectionRequired || !job.response) throw apiError(409, 'Saved job requires inspection before retrying.');
          return job.response;
        }
        if (!await availability()) throw apiError(503, 'Verified registration and model access are required before paid jobs.');
        const job = { id: randomUUID(), identifierFromPurchaser: body.identifier_from_purchaser,
          inputData: body.input_data, request, stage: 'quote-pending', status: 'awaiting_payment' };
        await save(job);
        await durableWrite(noncePath, JSON.stringify({ id: job.id, fingerprint }));
        await syncDirectory();
        try {
          const quoted = await dependencies.quote({ id: job.id, inputData: job.inputData, identifierFromPurchaser: job.identifierFromPurchaser });
          const response = quoteSchema.parse(quoted.response);
          if (response.id !== job.id || response.identifierFromPurchaser !== job.identifierFromPurchaser ||
            response.payByTime <= Math.floor(Date.now() / 1000) || response.payByTime >= response.submitResultTime ||
            response.submitResultTime > response.unlockTime || response.unlockTime > response.externalDisputeUnlockTime) {
            throw new Error('Quote identity or deadlines do not match.');
          }
          job.response = response;
          job.payment = quoted.payment;
          job.stage = 'awaiting-payment';
          await save(job);
          return response;
        } catch {
          job.status = 'failed'; job.inspectionRequired = true;
          await save(job);
          throw apiError(503, 'Quote outcome requires inspection. The purchaser identifier must not be resubmitted.');
        }
      });
    },
    async status(id) {
      const job = await load(id);
      return { status: job.inspectionRequired ? 'failed' : job.status,
        ...(job.status === 'completed' ? { result: job.result } : {}),
        ...(job.inspectionRequired ? { message: 'Saved job requires operator inspection.' } : {}) };
    },
    async advance(id) {
      return serial(async () => {
        const job = await load(id);
        if (job.status === 'completed') return { status: 'completed', result: job.result };
        if (job.inspectionRequired || job.stage !== 'awaiting-payment') throw apiError(409, 'Saved job requires inspection before execution.');
        const expired = () => Date.now() >= job.response.submitResultTime * 1000;
        const expire = async () => {
          job.inspectionRequired = true; job.stage = 'deadline-expired'; job.status = 'failed'; await save(job);
          return { status: 'failed', message: 'Result deadline expired. Inspect the existing payment.' };
        };
        if (expired()) return expire();
        if (!await availability()) throw apiError(503, 'Agent dependencies are unavailable.');
        if (expired()) return expire();
        // Polling chain state is read-only; a failure leaves this checkpoint retryable.
        if (await dependencies.fundsLocked(job) !== true) return { status: 'awaiting_payment' };
        if (expired()) return expire();
        try {
          job.stage = 'model-pending'; job.status = 'running'; await save(job);
          const result = await dependencies.runAgent(job.request, job, async sessionId => {
            if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(sessionId)) throw new Error('Invalid agent session ID.');
            job.sessionId = sessionId; job.stage = 'model-running'; await save(job);
          });
          if (typeof result !== 'string' || !result.trim() || Buffer.byteLength(result, 'utf8') > RESULT_LIMIT) throw new Error('Invalid final result.');
          job.result = result; job.stage = 'result-saved'; await save(job);
          job.stage = 'submit-result-pending'; await save(job);
          const evidence = await dependencies.submitResult(job, result);
          if (evidence?.confirmed !== true) throw new Error('Result submission was not confirmed.');
          job.resultSubmission = evidence; job.stage = 'completed'; job.status = 'completed'; await save(job);
          return { status: 'completed', result };
        } catch {
          job.inspectionRequired = true; job.status = 'failed'; await save(job);
          throw apiError(503, 'Job outcome requires inspection. Automatic execution retries are disabled.');
        }
      });
    },
    async close() { await tail; closed = true; await lock.close(); await unlink(resolve(root, 'owner.lock')); },
  };
}

async function readBody(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw apiError(415, 'Use application/json.');
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw apiError(413, 'Request body exceeds 64 KiB.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw apiError(400, 'Request body must be JSON.'); }
}

// Loopback is always allowed. A hosted deployment lists its public hostnames in ALLOWED_HOSTS (comma separated).
export const allowedHosts = (env = process.env) => new Set(['127.0.0.1', 'localhost', '[::1]', ...(env.ALLOWED_HOSTS ?? '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean)]);

export function createAgentServer(manager, hosts = allowedHosts(), chat) {
  return createServer(async (request, response) => {
    const send = (code, value) => { response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
    try {
      const host = new URL(`http://${request.headers.host}`);
      if (!hosts.has(host.hostname)) throw apiError(403, 'Host is not allowed.');
      if (request.headers.origin) {
        const origin = new URL(request.headers.origin);
        if (!hosts.has(origin.hostname)) throw apiError(403, 'Remote browser origins are not accepted.');
      }
      const url = new URL(request.url, 'http://127.0.0.1');
      // Sokosumi chat: an OpenAI Responses-compatible path. Register this server's /v1 as the Coworker's baseURL.
      if (chat && request.method === 'GET' && url.pathname === '/v1/models') return send(200, chat.models());
      if (chat && request.method === 'POST' && url.pathname === '/v1/responses') {
        const body = await readBody(request), reply = await chat.respond(body);
        if (body.stream !== true) return send(200, reply);
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
        for (const { type, data } of chat.stream(reply)) response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        return response.end();
      }
      if (request.method === 'GET' && url.pathname === '/input_schema') return send(200, inputSchema);
      if (request.method === 'GET' && url.pathname === '/availability') {
        const available = await manager.availability();
        return send(200, { status: available ? 'available' : 'unavailable', type: 'masumi-agent' });
      }
      if (request.method === 'GET' && url.pathname === '/status') return send(200, await manager.status(url.searchParams.get('job_id')));
      if (request.method === 'POST' && url.pathname === '/start_job') return send(200, await manager.start(await readBody(request)));
      send(404, { error: 'Endpoint not found.' });
    } catch (error) { send(error.statusCode || 503, { error: error.statusCode ? error.message : 'Service unavailable. Inspect local state.' }); }
  });
}

// The traveller's words are data. The date is ours, so "tomorrow" and missing years resolve correctly.
export const travelPrompt = (request, now = new Date()) => `Today is ${now.toISOString().slice(0, 10)}.\nTraveller request: ${JSON.stringify(request)}`;

export function eveJobRunner(eve) {
  return async (request, _job, persistSession) => {
    const { session } = await eve.sessions.create();
    await persistSession(session.state.sessionId);
    const response = await session.send(travelPrompt(request));
    const result = await response.result();
    if (!['waiting', 'completed'].includes(result.status) || result.inputRequests?.length ||
      result.events?.some(event => ['authorization.required', 'turn.failed'].includes(event.type))) {
      throw new Error('Agent has no final result.');
    }
    return result.message;
  };
}

async function main() {
  let dependencies = {};
  const { isHosted } = await import('./hosted.mjs');
  // Without a confirmed registration there are no dependencies, so /availability reports unavailable and /start_job refuses.
  if (isHosted() || existsSync(resolve(import.meta.dirname, '../.local/registration.json'))) {
    const { loadPaidConfiguration } = await import('./paid-worker.mjs');
    const { createStandardAdapter } = await import('./standard-adapter.mjs');
    const config = await loadPaidConfiguration();
    dependencies = createStandardAdapter({ ...config, eve: createEveClient() });
  }
  const manager = await createJobManager({ dependencies });
  const stop = new AbortController();
  const advance = async () => {
    let consecutiveFailures = 0;
    while (!stop.signal.aborted) {
      try {
        for (const id of await manager.listAwaiting()) {
          if (stop.signal.aborted) break;
          await manager.advance(id);
        }
        consecutiveFailures = 0;
      } catch {
        consecutiveFailures += 1;
        console.error('Agent job stopped. Inspect its existing payment and journal before retrying.');
        if (consecutiveFailures >= 3) { dependencies.registrationVerified = false; stop.abort(); server.close(); break; }
      }
      try { await delay(10_000, undefined, { signal: stop.signal }); }
      catch { break; }
    }
  };
  const eve = createEveClient();
  const chat = createChat({ turn: async prompt => {
    const { session } = await eve.sessions.create();
    const result = await (await session.send(prompt)).result();
    if (!['waiting', 'completed'].includes(result.status) || result.inputRequests?.length || !result.message?.trim()) throw new Error('No answer.');
    return result.message.trim();
  } });
  chat.stream = streamEvents;
  const server = createAgentServer(manager, allowedHosts(), chat);
  void advance();
  const port = Number(process.env.PORT || 3013), bind = process.env.HOST || '127.0.0.1';
  server.listen(port, bind, () => console.log(`Standard agent API listening on ${bind}:${port} (registration gates paid jobs).`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stop.abort(); server.close(async () => { await manager.close(); process.exit(0); }); });
  server.on('error', async () => { stop.abort(); await manager.close(); console.error('Agent API could not listen on its port.'); process.exitCode = 1; });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
