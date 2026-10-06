import test from 'node:test';
import assert from 'node:assert/strict';
import { hostedPaidConfiguration, hostedRuntime, isHosted } from '../scripts/hosted.mjs';
import { createHttpClient, httpRuntime } from '../scripts/sokosumi-http.mjs';

const env = {
  MASUMI_AGENT_IDENTIFIER: `${'a'.repeat(56)}${'b'.repeat(40)}`, MASUMI_SMART_CONTRACT_ADDRESS: 'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g',
  MASUMI_SELLER_VKEY: 'c'.repeat(56), MASUMI_SELLER_ADDRESS: 'addr_test1qrxk7ly3666nv8agvr6ylxn0lfycwnqjzmhynwxnjlxz7f9ehwykv3ee8k2hyts0y97w2th2qh7jqedkpaguzeh3fp7sw3t9vu',
  SOKOSUMI_COWORKER_ID: 'cw_1', SOKOSUMI_COWORKER_API_KEY: 'coworker_test', MPS_URL: 'https://mps.example.com/api/v1', MPS_TOKEN: 'token', BLOCKFROST_API_KEY_PREPROD: 'preprodTest',
};

test('hosted mode starts only when a registration identifier is configured', () => {
  assert.equal(isHosted({}), false);
  assert.equal(isHosted(env), true);
});

test('hosted payment configuration is built from the environment and checks required values', () => {
  const config = hostedPaidConfiguration(env);
  assert.equal(config.source.policyId, 'a'.repeat(56));
  assert.equal(config.source.supportedPaymentSourceIndex, 0);
  assert.equal(config.coworkerId, 'cw_1');
  for (const name of Object.keys(env).filter(key => key !== 'SOKOSUMI_COWORKER_API_KEY')) assert.throws(() => hostedPaidConfiguration({ ...env, [name]: '' }), /not set/);
});

test('hosted runtime refuses a malformed Coworker key', () => {
  assert.throws(() => hostedRuntime({ ...env, SOKOSUMI_COWORKER_API_KEY: 'oauth-token' }), /runtime key/);
});

test('http runtime lists only READY tasks assigned to this Coworker and completes with the result text', async () => {
  const calls = [];
  const send = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body && JSON.parse(init.body), auth: init.headers.authorization });
    if (String(url).includes('/v1/tasks?')) return Response.json({ data: [{ id: 't1', status: 'READY', assigneeId: 'cw_1' }, { id: 't2', status: 'READY', assigneeId: 'other' }, { id: 't3', status: 'RUNNING', assigneeId: 'cw_1' }] });
    return Response.json({ data: { id: 'e1', taskId: 't1', status: JSON.parse(init.body).status } });
  };
  const runtime = httpRuntime('cw_1', createHttpClient('coworker_test', send));
  assert.deepEqual((await runtime.list()).map(task => task.id), ['t1']);
  assert.deepEqual(await runtime.complete('t1', '/ignored', 'Final plan'), { status: 'COMPLETED', taskId: 't1', eventId: 'e1' });
  assert.deepEqual(calls.at(-1).body, { status: 'COMPLETED', comment: 'Final plan' });
  assert.equal(calls.at(-1).auth, 'Bearer coworker_test');
  await assert.rejects(runtime.complete('t1', '/x', '   '), /Invalid result/);
});
