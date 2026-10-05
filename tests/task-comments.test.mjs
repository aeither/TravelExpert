import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../scripts/worker-state.mjs';
import { humanComments, processComments } from '../scripts/task-comments.mjs';

const task = { id: 'task_test', status: 'COMPLETED', organizationId: null, assigneeId: 'coworker_test' };
const human = (id, text = 'What about payments?') => ({ id, taskId: task.id, actor: { type: 'user', id: 'user_test' }, comment: text });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'comments-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await createStore(join(dir, 'worker'));
  const commentStore = await createStore(join(dir, 'comments'));
  const resultFile = await store.result(task.id, 'Original paid answer\n');
  await store.save({ taskId: task.id, coworkerId: task.assigneeId, stage: 'collection-pending',
    eventId: 'completion_test', sessionId: 'wrun_test', resultFile, resultHash: 'unchanged', paymentProof: { receipt: 'original' } });
  const original = await readFile(join(dir, 'worker', 'task_test.json'), 'utf8');
  const events = [human('old_comment'), { id: 'completion_test', taskId: task.id, actor: { type: 'coworker', id: task.assigneeId }, comment: 'Original paid answer' }, human('new_comment')];
  const calls = [];
  const dependencies = { coworkerId: task.assigneeId, store, commentStore,
    core: { task: async () => task, events: async () => events, comment: async (id, text, coworkerId) => {
      calls.push(['post', id, text, coworkerId]);
      events.push({ id: 'reply_test', taskId: id, actor: { type: 'coworker', id: coworkerId }, comment: text });
      return 'reply_test';
    } },
    eve: { sessions: { attach: (id, options) => {
      calls.push(['attach', id, options]);
      return { state: { sessionId: id, streamIndex: 42 }, send: async text => {
        calls.push(['send', text]); return { result: async () => ({ status: 'waiting', message: 'Follow-up answer' }) };
      } };
    } } },
  };
  return { dependencies, calls, events, original, dir, resultFile };
}

test('reuses paid session, replies once, skips old comments and own replies, preserves paid bytes', async t => {
  const f = await fixture(t);
  assert.equal((await processComments(f.dependencies)).status, 'comment-replied');
  assert.equal((await processComments(f.dependencies)).status, 'idle');
  assert.equal(f.calls.filter(c => c[0] === 'send').length, 1);
  assert.equal(f.calls[0][1], 'wrun_test');
  assert.equal((await f.dependencies.commentStore.read(task.id)).streamIndex, 42);
  assert.equal(await readFile(join(f.dir, 'worker', 'task_test.json'), 'utf8'), f.original);
  assert.equal(await readFile(f.resultFile, 'utf8'), 'Original paid answer\n');
});

test('only preferred user actor counts, even when bot rows have legacy userId', () => {
  assert.deepEqual(humanComments([human('human'), { ...human('bot'), actor: { type: 'sokoBot' }, userId: 'user_test' },
    { ...human('own'), actor: { type: 'coworker' } }, { ...human('unknown'), actor: null }, human('empty', '  ')]).map(e => e.id), ['human']);
});

test('initial comments consumed at task start do not reply again; comments during execution do', async t => {
  const f = await fixture(t); const state = await f.dependencies.store.read(task.id);
  state.initialCommentIds = ['old_comment']; await f.dependencies.store.save(state);
  f.events.splice(1, 0, human('during_execution'));
  assert.equal((await processComments(f.dependencies)).commentId, 'during_execution');
});

test('model send uncertainty survives restart without another send or post', async t => {
  const f = await fixture(t); let sends = 0;
  f.dependencies.eve.sessions.attach = () => ({ send: async () => { sends++; throw new Error('secret'); } });
  assert.equal((await processComments(f.dependencies)).status, 'comment-inspection-required');
  const restarted = { ...f.dependencies, commentStore: await createStore(join(f.dir, 'comments')) };
  assert.equal((await processComments(restarted)).status, 'comment-inspection-required');
  assert.equal(sends, 1); assert.equal(f.calls.length, 0);
  assert.ok(!JSON.stringify(await restarted.commentStore.read(task.id)).includes('secret'));
});

test('accepted but unconfirmed post recovers matching coworker event without reposting', async t => {
  const f = await fixture(t); const post = f.dependencies.core.comment;
  f.dependencies.core.comment = async (...args) => { await post(...args); throw new Error('timeout'); };
  assert.equal((await processComments(f.dependencies)).status, 'comment-inspection-required');
  assert.equal((await processComments(f.dependencies)).status, 'comment-recovered');
  assert.equal((await processComments(f.dependencies)).status, 'idle');
  assert.equal(f.calls.filter(c => c[0] === 'post').length, 1);
});

test('unknown post outcome never retries automatically', async t => {
  const f = await fixture(t); let posts = 0;
  f.dependencies.core.comment = async () => { posts++; throw new Error('timeout'); };
  await processComments(f.dependencies); await processComments(f.dependencies);
  assert.equal(posts, 1);
});

test('reassignment before posting preserves saved reply and prevents write', async t => {
  const f = await fixture(t); let reads = 0;
  f.dependencies.core.task = async () => ++reads === 1 ? task : { ...task, assigneeId: 'other' };
  assert.equal((await processComments(f.dependencies)).status, 'comment-inspection-required');
  assert.equal(f.calls.filter(c => c[0] === 'post').length, 0);
  assert.equal((await f.dependencies.commentStore.read(task.id)).items[0].stage, 'reply-saved');
  f.dependencies.core.task = async () => task;
  assert.equal((await processComments(f.dependencies)).status, 'comment-replied');
  assert.equal(f.calls.filter(c => c[0] === 'send').length, 1);
});

test('terminal or unknown session blocks without creating replacement', async t => {
  const f = await fixture(t);
  f.dependencies.eve.sessions.attach = () => { throw new Error('terminal session'); };
  assert.equal((await processComments(f.dependencies)).status, 'comment-inspection-required');
  assert.equal(f.calls.length, 0);
});

test('missing completion boundary and mismatched events fail before model', async t => {
  const f = await fixture(t); f.events.splice(1, 1);
  assert.equal((await processComments(f.dependencies)).status, 'comment-inspection-required');
  f.events[0].taskId = 'other';
  assert.equal((await processComments(f.dependencies)).status, 'comment-inspection-required');
  assert.equal(f.calls.length, 0);
});

async function secondTask(f) {
  const extra = { ...task, id: 'task_zother' };
  await f.dependencies.store.save({ ...(await f.dependencies.store.read(task.id)), taskId: extra.id, sessionId: 'wrun_other' });
  f.dependencies.core.task = async id => id === task.id ? task : extra;
  f.dependencies.core.events = async id => f.events.map(event => ({ ...event, taskId: id }));
  f.dependencies.core.comment = async (id, text) => { f.calls.push(['post', id, text]); return 'reply_' + id; };
}

test('one reply per Task per pass prevents a busy Task starving another', async t => {
  const f = await fixture(t); await secondTask(f);
  await processComments(f.dependencies);
  assert.deepEqual(f.calls.filter(c => c[0] === 'post').map(c => c[1]), ['task_test', 'task_zother']);
});

test('revoked access on one saved Task does not stop replies to other Tasks', async t => {
  const f = await fixture(t); await secondTask(f);
  const read = f.dependencies.core.task;
  f.dependencies.core.task = async id => { if (id === task.id) throw new Error('403 secret'); return read(id); };
  const result = await processComments(f.dependencies);
  assert.ok(f.calls.some(c => c[0] === 'post' && c[1] === 'task_zother'));
  assert.ok(!JSON.stringify(result).includes('secret'));
});
