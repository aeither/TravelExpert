import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'eve/client';
import { createStore, safeId } from './worker-state.mjs';
import { COMMENT_DIRECTORY, humanComments, processComments } from './task-comments.mjs';
import { createCoreRuntime } from './core-runtime.mjs';

export const WORKER_DIRECTORY = resolve(import.meta.dirname, '../.local/worker');

const execute = promisify(execFile);
const RESULT_LIMIT = 1_048_576;
const POLL_DELAY_MS = 10_000;
const CLI_TIMEOUT_MS = 900_000;

export function validateTask(task, coworkerId, status = 'READY') {
  safeId(task?.id);
  if (task.status !== status || task.organizationId !== null ||
      (task.assigneeId ?? task.coworkerId) !== coworkerId ||
      typeof task.description !== 'string' || !task.description.trim()) {
    throw new Error('Task identity, personal Workspace, status, or input does not match.');
  }
}

export function hasPayment(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) =>
    /masumipayment/i.test(key) ||
    (typeof item === 'string' && /^masumipayment$/i.test(item)) ||
    (typeof item === 'object' && hasPayment(item)));
}

export async function processTask(task, { coworkerId, store, runtime, eve, payments }) {
  validateTask(task, coworkerId);
  const previous = await store.read(task.id);
  if (previous?.stage === 'completed') return { taskId: task.id, status: 'skipped' };
  if (previous) throw new Error(`Task ${task.id} has saved progress. Inspect Task and eve session before resuming.`);
  const detail = await runtime.inspect(task.id);
  validateTask(detail.task, coworkerId);
  if (!Array.isArray(detail.events) || detail.detailsErrors?.some(error => error.resource === 'events')) {
    throw new Error('Task payment events could not be inspected. Execution was not started.');
  }
  if (hasPayment(detail)) throw new Error('Paid Task requires a configured payment adapter. Execution was not started.');
  await eve.health();
  const comments = humanComments(detail.events);
  const state = { taskId: task.id, coworkerId, stage: 'start-pending', executionOnly: !payments,
    initialCommentIds: comments.map(event => safeId(event.id)) };
  const save = async stage => { state.stage = stage; await store.save(state); };
  await save('start-pending');
  try {
    const started = await runtime.start(task.id);
    validateTask(started, coworkerId, 'RUNNING');
    await save('running');
    if (payments) await payments.request(started, state, save);
    const requirePaidDeadline = () => {
      if (!payments) return;
      const deadline = Date.parse(state.plan?.submitResultTime);
      if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new Error('Paid model result deadline expired.');
    };
    requirePaidDeadline();
    await save('session-create-pending');
    const { session } = await eve.sessions.create();
    state.sessionId = safeId(session.state.sessionId);
    await save('send-pending');
    const input = comments.length ? `${started.description}\n\nExisting human Task comments:\n${JSON.stringify(comments.map(event => ({ commentId: event.id, comment: event.comment })))}` : started.description;
    requirePaidDeadline();
    const response = await session.send(input);
    await save('model-running');
    const result = await response.result();
    if (!['completed', 'waiting'].includes(result.status) || result.inputRequests?.length ||
        result.events?.some(event => event.type === 'authorization.required' || event.type === 'turn.failed') ||
        typeof result.message !== 'string' ||
        !result.message.trim() || Buffer.byteLength(result.message, 'utf8') > RESULT_LIMIT) {
      throw new Error('Agent did not return a completed UTF-8 result within 1 MiB.');
    }
    state.resultFile = await store.result(task.id, result.message);
    await save('result-saved');
    if (payments) await payments.submit(state, result.message, save);
    await save('complete-pending');
    const completed = await runtime.complete(task.id, state.resultFile);
    if (completed.status !== 'COMPLETED' || completed.taskId !== task.id || !completed.eventId) {
      throw new Error('Task completion was not confirmed.');
    }
    state.eventId = safeId(completed.eventId);
    await save('task-completed');
    if (payments) state.paymentProof = await payments.settle(state, save);
    await save('completed');
    return { taskId: task.id, status: 'COMPLETED', eventId: state.eventId, executionOnly: !payments };
  } catch {
    // Do not persist provider or CLI error bodies, which can contain credentials.
    state.inspectionRequired = true;
    await store.save(state);
    throw new Error(`Task ${task.id} stopped at ${state.stage}. Inspect saved Task and session state before retrying.`);
  }
}

export async function runOnce(dependencies) {
  const release = await dependencies.store.lock(dependencies.coworkerId);
  try {
    const comments = dependencies.commentStore ? await processComments(dependencies) : null;
    const tasks = await dependencies.runtime.list();
    for (const task of tasks) {
      const saved = await dependencies.store.read(task.id);
      if (saved?.stage === 'completed') continue;
      const result = await processTask(task, dependencies);
      return comments && comments.status !== 'idle' ? { ...result, comments } : result;
    }
    return comments ?? { status: 'idle' };
  } finally { await release(); }
}

export function cliRuntime(coworkerId, run = execute) {
  async function call(args) {
    try {
      const { stdout } = await run('sokosumi', ['--preprod', ...args, '--json'], {
        timeout: CLI_TIMEOUT_MS, maxBuffer: 2 * RESULT_LIMIT,
      });
      return JSON.parse(stdout);
    } catch { throw new Error('Sokosumi command failed. Inspect current Task state in a trusted terminal.'); }
  }
  return {
    async list() {
      const response = await call(['tasks', 'list', '--status', 'READY', '--coworker-id', coworkerId, '--limit', '100']);
      if (!Array.isArray(response.tasks)) throw new Error('Invalid Task list response.');
      return response.tasks;
    },
    inspect: id => call(['tasks', 'get', safeId(id)]),
    start: id => call(['runtime', 'start', safeId(id), '--coworker-id', coworkerId, '--personal']),
    complete: (id, path) => call(['runtime', 'complete', safeId(id), '--coworker-id', coworkerId, '--personal', '--result-file', path]),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--once', '--poll'].includes(arg)) || (args.includes('--once') && args.includes('--poll'))) {
    throw new Error('Use --once (default) or --poll.');
  }
  const coworkerId = safeId(process.env.COWORKER_ID);
  const host = new URL(process.env.EVE_URL || 'http://127.0.0.1:2000');
  if (host.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(host.hostname) || host.username || host.password) {
    throw new Error('Local worker requires a loopback HTTP EVE_URL without credentials.');
  }
  const dependencies = {
    coworkerId, store: await createStore(WORKER_DIRECTORY),
    commentStore: await createStore(COMMENT_DIRECTORY), core: await createCoreRuntime(coworkerId),
    runtime: cliRuntime(coworkerId), eve: new Client({ host: host.href, redirect: 'error' }),
  };
  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort());
  do {
    if (stop.signal.aborted) break;
    console.log(JSON.stringify(await runOnce(dependencies)));
    if (!args.includes('--poll')) break;
    try { await delay(POLL_DELAY_MS, undefined, { signal: stop.signal }); }
    catch { break; }
  } while (!stop.signal.aborted);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
