import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoreRuntime, scopeCoreRuntime } from '../scripts/core-runtime.mjs';

test('D7: payment runtime constructs the Coworker client without user context', async () => {
  let options;
  let requestedCredential;
  const paths = [];
  const runtime = await createCoreRuntime('coworker_test', 'user_test', { loadRuntime: async () => ({
    readRuntimeCredential(id) { requestedCredential = id; return 'coworker_test-only-key'; },
    createCoworkerHttpClient(value) {
      options = value;
      return {
        async get(path) { paths.push(path); return { data: {
          id: 'coworker_test', archivedAt: null, capabilities: ['tasks'],
        } }; },
        async post() { return { data: { id: 'payment_event' } }; },
      };
    },
  }) });
  assert.equal(requestedCredential, 'coworker_test');
  assert.deepEqual(paths, ['/v1/coworkers/me']);
  assert.deepEqual(options, { apiKey: 'coworker_test-only-key' });
  assert.equal(await runtime.payment('task_test', { masumiPayment: {} }), 'payment_event');
});

test('Core adapter limits receipt routes and confirms payment events without error body leaks', async () => {
  const calls = [];
  const client = scopeCoreRuntime({
    async get(path) { calls.push(path); return { data: { settled: false } }; },
    async post(path, body) { calls.push({ path, body }); return { data: { id: 'payment-event' } }; },
  });
  await assert.rejects(client.get('/v1/coworkers/me'), /Unsupported/);
  assert.equal((await client.get('/v1/tasks/task_test/receipt')).data.settled, false);
  assert.equal(await client.payment('task_test', { masumiPayment: { test: true } }), 'payment-event');
  assert.equal(calls[1].path, '/v1/tasks/task_test/events');
  const failed = scopeCoreRuntime({ post: async () => { throw new Error('secret-token'); } });
  await assert.rejects(failed.payment('task_test', {}), error => error.message.includes('uncertain') && !error.message.includes('secret-token'));
  await assert.rejects(failed.payment('../credentials', {}), /Invalid/);
});

test('comment pages follow cursors and replies post only text with confirmed coworker actor', async () => {
  const calls = [];
  const core = scopeCoreRuntime({
    get: async path => {
      calls.push(path); const second = path.includes('cursor=');
      return { data: [{ id: second ? 'event_2' : 'event_1', taskId: 'task_test' }], meta: { pagination: { nextCursor: second ? null : 'event_1' } } };
    },
    post: async (path, body) => {
      calls.push({ path, body }); return { data: { id: 'reply_1', taskId: 'task_test', actor: { type: 'coworker', id: 'coworker_test' }, comment: body.comment } };
    },
  });
  assert.deepEqual((await core.events('task_test')).map(e => e.id), ['event_1', 'event_2']);
  assert.ok(calls[1].includes('cursor=event_1'));
  assert.equal(await core.comment('task_test', 'Exact reply', 'coworker_test'), 'reply_1');
  assert.deepEqual(calls[2].body, { comment: 'Exact reply' });
});

test('event reader rejects repeated cursor, incomplete pages and wrong Task', async () => {
  for (const page of [
    { data: [], meta: { pagination: { nextCursor: 'same_cursor' } } },
    { data: [], meta: {} },
    { data: [{ taskId: 'other' }], meta: { pagination: { nextCursor: null } } },
  ]) {
    await assert.rejects(scopeCoreRuntime({ get: async () => page }).events('task_test'), /completely/);
  }
});

test('reply confirmation rejects user actor and omits raw API errors', async () => {
  const core = scopeCoreRuntime({ post: async () => ({ data: { id: 'reply', taskId: 'task_test', actor: { type: 'user', id: 'coworker_test' }, comment: 'reply' } }) });
  await assert.rejects(core.comment('task_test', 'reply', 'coworker_test'), /uncertain/);
});

test('comment reader rejects a pagination object missing nextCursor', async () => {
  await assert.rejects(scopeCoreRuntime({ get: async () => ({ data: [], meta: { pagination: {} } }) }).events('task_test'), /completely/);
});
