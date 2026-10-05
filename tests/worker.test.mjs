import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createStore } from '../scripts/worker-state.mjs';
import { processTask, runOnce, validateTask } from '../scripts/worker.mjs';

const task = { id: 'task_test', coworkerId: 'coworker_test', organizationId: null, status: 'READY', description: 'Find events' };

async function fixture(t, failure) {
  const directory = await mkdtemp(join(tmpdir(), 'event-worker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const action = async (name, value) => {
    calls.push(name);
    if (name === failure) throw new Error('token=secret-must-not-persist');
    return value;
  };
  const dependencies = {
    coworkerId: task.coworkerId, store: await createStore(directory),
    runtime: {
      list: () => action('list', [task]),
      inspect: () => action('inspect', { task, events: [] }),
      start: () => action('start', { ...task, status: 'RUNNING' }),
      complete: () => action('complete', { taskId: task.id, status: 'COMPLETED', eventId: 'event_test' }),
    },
    eve: {
      health: () => action('health', { status: 'ready' }),
      sessions: { create: () => action('create', {
        session: { state: { sessionId: 'wrun_test' }, send: () => action('send', {
          result: () => action('result', { status: 'waiting', message: 'Event result\n', inputRequests: [], events: [] }),
        }) },
      }) },
    },
  };
  return { directory, dependencies, calls };
}

test('persists session, exact result, and confirmed completion; completed task never repeats', async t => {
  const { dependencies, calls } = await fixture(t);
  assert.equal((await runOnce(dependencies)).status, 'COMPLETED');
  const state = await dependencies.store.read(task.id);
  assert.equal(state.stage, 'completed');
  assert.equal(state.sessionId, 'wrun_test');
  assert.equal(await readFile(state.resultFile, 'utf8'), 'Event result\n');
  const oldCalls = calls.length;
  assert.equal((await processTask(task, dependencies)).status, 'skipped');
  assert.equal(calls.length, oldCalls);
});

test('sends authoritative started Task input rather than stale list input', async t => {
  const { dependencies } = await fixture(t);
  dependencies.runtime.inspect = async () => ({ task: { ...task, description: 'NEW input' }, events: [] });
  dependencies.runtime.start = async () => ({ ...task, description: 'NEW input', status: 'RUNNING' });
  let sent;
  dependencies.eve.sessions.create = async () => ({ session: {
    state: { sessionId: 'wrun_test' },
    send: async input => { sent = input; return { result: async () => ({ status: 'waiting', message: 'Result' }) }; },
  } });
  await runOnce(dependencies);
  assert.equal(sent, 'NEW input');
});

for (const [failure, stage] of [['start', 'start-pending'], ['create', 'session-create-pending'], ['send', 'send-pending'], ['result', 'model-running'], ['complete', 'complete-pending']]) {
  test(`uncertain ${failure} preserves stage and blocks duplicate execution`, async t => {
    const { dependencies } = await fixture(t, failure);
    await assert.rejects(runOnce(dependencies), /Inspect saved Task/);
    const state = await dependencies.store.read(task.id);
    assert.equal(state.stage, stage);
    assert.equal(state.inspectionRequired, true);
    assert.ok(!JSON.stringify(state).includes('secret-must-not-persist'));
    await assert.rejects(processTask(task, dependencies), /saved progress/);
  });
}

test('crash after journal write requires inspection before any operation', async t => {
  const { dependencies, calls } = await fixture(t);
  await dependencies.store.save({ taskId: task.id, stage: 'running' });
  await assert.rejects(processTask(task, dependencies), /saved progress/);
  assert.equal(calls.length, 0);
});

test('same Coworker lock prevents concurrent executors and remains after crash', async t => {
  const { dependencies } = await fixture(t);
  const release = await dependencies.store.lock(task.coworkerId);
  await assert.rejects(runOnce(dependencies), /Worker lock exists/);
  await release();
  assert.equal((await runOnce(dependencies)).status, 'COMPLETED');
});

test('paid Task does not enter execution-only path', async t => {
  const { dependencies, calls } = await fixture(t);
  dependencies.runtime.inspect = async () => ({ task, events: [{ data: { masumiPayment: {} } }] });
  await assert.rejects(runOnce(dependencies), /payment adapter/);
  assert.ok(!calls.includes('start'));
});

test('failed event inspection cannot bypass the payment gate', async t => {
  const { dependencies, calls } = await fixture(t);
  dependencies.runtime.inspect = async () => ({ task, detailsErrors: [{ resource: 'events' }] });
  await assert.rejects(runOnce(dependencies), /payment events could not be inspected/);
  assert.ok(!calls.includes('start'));
});

test('identity mismatch and unsafe paths fail closed', () => {
  assert.throws(() => validateTask({ ...task, coworkerId: 'other' }, task.coworkerId), /does not match/);
  assert.throws(() => validateTask({ ...task, organizationId: 'org' }, task.coworkerId), /does not match/);
  assert.throws(() => validateTask({ ...task, id: '../escape' }, task.coworkerId), /Invalid/);
});

test('agent waiting for human input cannot complete Task', async t => {
  const { dependencies, calls } = await fixture(t);
  dependencies.eve.sessions.create = async () => ({ session: { state: { sessionId: 'wrun_test' }, send: async () => ({
    result: async () => ({ status: 'waiting', message: 'Question', inputRequests: [{}] }),
  }) } });
  await assert.rejects(runOnce(dependencies), /model-running/);
  assert.ok(!calls.includes('complete'));
});

test('worker journal path stays in the repository across working directories', async () => {
  const { WORKER_DIRECTORY } = await import('../scripts/worker.mjs');
  assert.equal(WORKER_DIRECTORY, resolve(import.meta.dirname, '../.local/worker'));
});

test('paid Task requests funding before model and submits hash before completion and proof', async t => {
  const { dependencies, calls } = await fixture(t);
  dependencies.payments = {
    async request(_task, state, save) { state.plan = { submitResultTime: new Date(Date.now() + 60_000).toISOString() }; calls.push('payment'); await save('funds-confirmed'); },
    async submit(state, text, save) {
      assert.equal(await readFile(state.resultFile, 'utf8'), text);
      calls.push('hash'); await save('result-hash-submitted');
    },
    async settle(state, save) { calls.push('proof'); await save('collection-pending'); return { txHash: 'verified-test' }; },
  };
  const result = await runOnce(dependencies);
  assert.equal(result.executionOnly, false);
  assert.ok(calls.indexOf('payment') < calls.indexOf('create'));
  assert.ok(calls.indexOf('hash') < calls.indexOf('complete'));
  assert.ok(calls.indexOf('complete') < calls.indexOf('proof'));
  assert.deepEqual((await dependencies.store.read(task.id)).paymentProof, { txHash: 'verified-test' });
});

test('failed funding cannot run model or complete Task', async t => {
  const { dependencies, calls } = await fixture(t);
  dependencies.payments = { async request(_task, state, save) { await save('payment-event-pending'); throw new Error('uncertain'); } };
  await assert.rejects(runOnce(dependencies), /Inspect saved Task/);
  assert.equal((await dependencies.store.read(task.id)).stage, 'payment-event-pending');
  assert.ok(!calls.includes('create'));
  assert.ok(!calls.includes('complete'));
});

test('completed Task without seller proof remains pending instead of completed journal', async t => {
  const { dependencies } = await fixture(t);
  dependencies.payments = { request: async (_task, state) => { state.plan = { submitResultTime: new Date(Date.now() + 60_000).toISOString() }; }, submit: async () => {}, async settle(state, save) {
    await save('collection-pending'); throw new Error('not collected');
  } };
  await assert.rejects(runOnce(dependencies), /Inspect saved Task/);
  const state = await dependencies.store.read(task.id);
  assert.equal(state.stage, 'collection-pending');
  assert.equal(state.eventId, 'event_test');
  assert.equal(state.inspectionRequired, true);
});

test('D6: Task list omits unsupported personal option while runtime keeps it', async () => {
  const { cliRuntime } = await import('../scripts/worker.mjs');
  const commands = [];
  const runtime = cliRuntime('coworker_test', async (_bin, args) => { commands.push(args); return { stdout: '{"tasks":[]}' }; });
  await runtime.list();
  await runtime.start('task_test');
  assert.equal(commands[0].includes('--personal'), false);
  assert.equal(commands[1].includes('--personal'), true);
});

test('first execution includes existing human comments and saves consumed IDs', async t => {
  const { dependencies } = await fixture(t); let input;
  dependencies.runtime.inspect = async () => ({ task, events: [{ id: 'human_event', taskId: task.id, actor: { type: 'user', id: 'user_test' }, comment: 'Prefer payments' },
    { id: 'bot_event', actor: { type: 'coworker' }, comment: 'Ignore me' }] });
  dependencies.eve.sessions.create = async () => ({ session: { state: { sessionId: 'wrun_test' }, send: async text => {
    input = text; return { result: async () => ({ status: 'waiting', message: 'answer' }) };
  } } });
  await runOnce(dependencies);
  assert.ok(input.includes('Prefer payments')); assert.ok(!input.includes('Ignore me'));
  assert.deepEqual((await dependencies.store.read(task.id)).initialCommentIds, ['human_event']);
});

test('READY work does not skip polling comments on previously completed Tasks', async t => {
  const { dependencies, directory } = await fixture(t); const calls = [];
  const old = { ...task, id: 'old_task', status: 'COMPLETED' };
  await dependencies.store.save({ taskId: old.id, coworkerId: task.coworkerId, sessionId: 'wrun_old', eventId: 'old_completed', stage: 'completed' });
  dependencies.commentStore = await createStore(join(directory, 'comments'));
  dependencies.core = {
    task: async () => old,
    events: async () => [{ id: 'old_completed', taskId: old.id }, { id: 'new_human', taskId: old.id, actor: { type: 'user', id: 'user_test' }, comment: 'Follow up' }],
    comment: async () => { calls.push('comment'); return 'new_reply'; },
  };
  dependencies.eve.sessions.attach = () => ({ state: { streamIndex: 20 }, send: async () => ({ result: async () => ({ status: 'waiting', message: 'Reply' }) }) });
  const result = await runOnce(dependencies);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.comments.status, 'comment-replied');
  assert.deepEqual(calls, ['comment']);
});

test('D13: session creation crossing paid result deadline cannot send a model turn', async t => {
  const { dependencies, calls } = await fixture(t); const original = Date.now;
  const deadline = Date.now() + 60_000;
  dependencies.payments = { request: async (_task, state) => { state.plan = { submitResultTime: new Date(deadline).toISOString() }; } };
  const create = dependencies.eve.sessions.create;
  dependencies.eve.sessions.create = async () => { const result = await create(); Date.now = () => deadline; return result; };
  try {
    await assert.rejects(runOnce(dependencies), /Inspect saved Task/);
    assert.ok(!calls.includes('send'));
  } finally { Date.now = original; }
});
