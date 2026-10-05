import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createAgentServer, createJobManager, eveJobRunner, inputSchema, parseStart } from '../scripts/agent-api.mjs';

const input = { identifier_from_purchaser: '0123456789abcdef0123', input_data: { request: JSON.stringify({ interests: ['payments'], dates: ['2026-10-08'] }) } };
function signedResponse(job) {
  const now = Math.floor(Date.now() / 1000);
  return { id: job.id, blockchainIdentifier: 'test-blockchain-id', payByTime: now + 300,
    submitResultTime: now + 600, unlockTime: now + 900, externalDisputeUnlockTime: now + 1200,
    agentIdentifier: 'test-registration', sellerVKey: 'test-seller-key',
    identifierFromPurchaser: job.identifierFromPurchaser, input_hash: 'test-canonical-input-hash' };
}
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'token2049-api-test-'));
  const calls = [];
  const dependencies = {
    registrationVerified: true,
    modelHealth: async () => true,
    quote: async job => { calls.push('quote'); return { response: signedResponse(job), payment: { signedTerms: 'test-terms' } }; },
    fundsLocked: async () => { calls.push('funds'); return true; },
    runAgent: async (_request, job, persist) => {
      assert.equal(JSON.parse(await readFile(resolve(directory, `${job.id}.json`))).stage, 'model-pending');
      await persist('test-session-1'); calls.push('model'); return 'Exact UTF-8 result: café.';
    },
    submitResult: async (job, result) => {
      const saved = JSON.parse(await readFile(resolve(directory, `${job.id}.json`)));
      assert.equal(saved.stage, 'submit-result-pending'); assert.equal(saved.result, result);
      calls.push('submit'); return { confirmed: true, resultHash: 'test-canonical-result-hash' };
    },
    ...overrides,
  };
  const manager = await createJobManager({ directory, dependencies });
  let released = false;
  const close = async () => { if (!released) { released = true; await manager.close(); } };
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, dependencies, calls, manager, close };
}

test('MIP003 schema exposes one request string; malformed parameters never request terms', async t => {
  assert.equal(inputSchema.input_data.length, 1);
  assert.equal(inputSchema.input_data[0].id, 'request');
  assert.equal(inputSchema.input_data[0].type, 'string');
  const f = await fixture(t);
  for (const body of [{}, { ...input, input_data: { request: '{' } },
    { ...input, input_data: { request: '{"interests":[]}' } },
    { ...input, extra: true }, { ...input, identifier_from_purchaser: 'buyer-nonce-1' },
    { ...input, input_data: { ...input.input_data, unexpected: true } }]) {
    await assert.rejects(f.manager.start(body), { statusCode: 400 });
  }
  assert.deepEqual(f.calls, []);
  assert.equal(parseStart(input).request.availableFrom, '00:00');
});

test('unverified registration and failed model health make paid jobs unavailable', async t => {
  const f = await fixture(t, { registrationVerified: false });
  assert.equal(await f.manager.availability(), false);
  await assert.rejects(f.manager.start(input), { statusCode: 503 });
  assert.deepEqual(f.calls, []);
  f.dependencies.registrationVerified = true; f.dependencies.modelHealth = async () => false;
  assert.equal(await f.manager.availability(), false);
});

test('terms precede FundsLocked, model, and result submission; completed jobs never execute twice', async t => {
  const f = await fixture(t);
  const response = await f.manager.start(input);
  assert.equal((await f.manager.status(response.id)).status, 'awaiting_payment');
  assert.deepEqual(await f.manager.listAwaiting(), [response.id]);
  assert.deepEqual(await f.manager.start(input), response);
  const completed = await f.manager.advance(response.id);
  assert.deepEqual(f.calls, ['quote', 'funds', 'model', 'submit']);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result, 'Exact UTF-8 result: café.');
  assert.deepEqual(await f.manager.listAwaiting(), []);
  assert.deepEqual(await f.manager.advance(response.id), completed);
  assert.deepEqual(f.calls, ['quote', 'funds', 'model', 'submit']);
  await assert.rejects(f.manager.start({ ...input, input_data: { request: '{"interests":["ai"]}' } }), { statusCode: 409 });
});

test('unfunded escrow cannot start the model', async t => {
  const f = await fixture(t, { fundsLocked: async () => false });
  const response = await f.manager.start(input);
  assert.deepEqual(await f.manager.advance(response.id), { status: 'awaiting_payment' });
  assert.deepEqual(f.calls, ['quote']);
});

test('D9: expired waiting job leaves polling without stopping API availability or replacing terms', async t => {
  const f = await fixture(t);
  const response = await f.manager.start(input);
  const path = resolve(f.directory, `${response.id}.json`);
  const saved = JSON.parse(await readFile(path));
  saved.response.submitResultTime = Math.floor(Date.now() / 1000) - 1;
  await writeFile(path, JSON.stringify(saved));
  assert.equal((await f.manager.advance(response.id)).status, 'failed');
  assert.deepEqual(await f.manager.listAwaiting(), []);
  assert.equal(await f.manager.availability(), true);
  assert.deepEqual(f.calls, ['quote']);
  const expired = JSON.parse(await readFile(path));
  assert.deepEqual(expired.payment, saved.payment);
  assert.equal(expired.inspectionRequired, true);
  await assert.rejects(f.manager.start(input), { statusCode: 409 });
});

test('D9: funding check crossing the result deadline cannot start the model', async t => {
  const f = await fixture(t);
  const response = await f.manager.start(input);
  const originalNow = Date.now;
  f.dependencies.fundsLocked = async () => { Date.now = () => response.submitResultTime * 1000; return true; };
  try {
    assert.equal((await f.manager.advance(response.id)).status, 'failed');
    assert.ok(!f.calls.includes('model'));
    assert.deepEqual(await f.manager.listAwaiting(), []);
  } finally { Date.now = originalNow; }
});

test('uncertain quote and submission writes block retries without exposing error bodies', async t => {
  const quoteFailure = await fixture(t, { quote: async () => { throw new Error('private provider detail'); } });
  await assert.rejects(quoteFailure.manager.start(input), error => error.statusCode === 503 && !error.message.includes('private'));
  await assert.rejects(quoteFailure.manager.start(input), { statusCode: 409 });
  const submitFailure = await fixture(t, { submitResult: async () => { throw new Error('private token'); } });
  const response = await submitFailure.manager.start(input);
  await assert.rejects(submitFailure.manager.advance(response.id), { statusCode: 503 });
  assert.equal((await submitFailure.manager.status(response.id)).status, 'failed');
  await assert.rejects(submitFailure.manager.advance(response.id), { statusCode: 409 });
  assert.equal(submitFailure.calls.filter(value => value === 'model').length, 1);
});

test('restart marks pending model writes for inspection and preserves the same purchaser record', async t => {
  const f = await fixture(t);
  const response = await f.manager.start(input);
  await f.close();
  const path = resolve(f.directory, `${response.id}.json`);
  const saved = JSON.parse(await readFile(path)); saved.stage = 'model-running'; saved.status = 'running';
  await writeFile(path, JSON.stringify(saved));
  const restarted = await createJobManager({ directory: f.directory, dependencies: f.dependencies });
  try {
    assert.equal((await restarted.status(response.id)).status, 'failed');
    assert.deepEqual(await restarted.listAwaiting(), []);
    await assert.rejects(restarted.start(input), { statusCode: 409 });
    await assert.rejects(restarted.advance(response.id), { statusCode: 409 });
    assert.deepEqual(f.calls, ['quote']);
  } finally { await restarted.close(); }
});

test('journal owner lock excludes a second executor', async t => {
  const f = await fixture(t);
  await assert.rejects(createJobManager({ directory: f.directory, dependencies: f.dependencies }), /owner lock/);
});

test('eve runner saves its session before sending and rejects unfinished turns', async () => {
  const order = [];
  const eve = { sessions: { create: async () => ({ session: { state: { sessionId: 'session-1' },
    send: async () => { order.push('send'); return { result: async () => ({ status: 'waiting', message: 'result' }) }; } } }) } };
  assert.equal(await eveJobRunner(eve)({ interests: ['payments'] }, {}, async () => order.push('save')), 'result');
  assert.deepEqual(order, ['save', 'send']);
  eve.sessions.create = async () => ({ session: { state: { sessionId: 'session-1' }, send: async () => ({ result: async () => ({ status: 'running' }) }) } });
  await assert.rejects(eveJobRunner(eve)({}, {}, async () => {}), /no final result/);
});

test('HTTP contract serves schema and status; enforces JSON, body size, and loopback host', async t => {
  const f = await fixture(t, { registrationVerified: false });
  const server = createAgentServer(f.manager);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(`${url}/input_schema`)).json(), inputSchema);
  assert.deepEqual(await (await fetch(`${url}/availability`)).json(), { status: 'unavailable', type: 'masumi-agent' });
  assert.equal((await fetch(`${url}/status?job_id=bad`)).status, 400);
  const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) };
  assert.equal((await fetch(`${url}/start_job`, request)).status, 503);
  assert.equal((await fetch(`${url}/start_job`, { ...request, body: 'x'.repeat(65_537) })).status, 413);
  assert.equal((await fetch(`${url}/start_job`, { ...request, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await fetch(`${url}/availability`, { headers: { origin: 'https://evil.example' } })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const call = httpRequest(`${url}/availability`, { headers: { host: 'evil.example' } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    });
    call.on('error', reject); call.end();
  });
  assert.equal(hostStatus, 403);
});
