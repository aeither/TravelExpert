import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaidAdapter } from '../scripts/paid-adapter.mjs';
import { createStandardAdapter } from '../scripts/standard-adapter.mjs';
import { hashMip004Result, hashPaymentResult, TEST_USDM_UNIT } from '../scripts/payment.ts';
import { source, quote } from './payment-fixtures.mjs';

function mockPayment() {
  let plan;
  const calls = [];
  const state = {};
  const save = async stage => { state.stage = stage; calls.push(stage); };
  const mps = { async post(path, body) {
    calls.push(path);
    if (path === 'payment') {
      plan = state.plan;
      return { data: quote(plan) };
    }
    if (path === 'payment/submit-result') return { data: { ...quote(plan, true), NextAction: {
      requestedAction: 'SubmitResult', errorType: null, resultHash: body.submitResultHash,
    } } };
    const current = quote(plan, true);
    if (state.stage === 'collection-pending') {
      current.onChainState = 'Withdrawn'; current.CurrentTransaction.txHash = 'd'.repeat(64);
    }
    return { data: current };
  } };
  return { mps, calls, state, save, setPlan: value => { plan = value; } };
}

test('paid adapter binds terms, charges once, submits exact saved answer hash, and verifies seller proof', async () => {
  const mock = mockPayment();
  const core = {
    async payment(id, event) { mock.calls.push('core-payment'); assert.equal(id, 'task_test');
      assert.equal(event.masumiPayment.inputHash, mock.state.plan.inputHash); return 'payment_event'; },
    async get() { return { data: { blockchainIdentifier: 'signed-terms-test', claimStatus: 'settled', onChainState: 'Withdrawn',
      settled: true, txHash: 'd'.repeat(64), withdrawnForSeller: [{ unit: TEST_USDM_UNIT, amount: '1000000' }] } }; },
  };
  const adapter = createPaidAdapter({ source, mps: mock.mps, core, blockfrostKey: 'test-only',
    verify: async (tx, plan) => { assert.equal(tx, 'd'.repeat(64)); assert.equal(plan.source.sellerAddress, source.sellerAddress); return { confirmed: true }; } });
  Object.assign(mock.state, { taskId: 'task_test' });
  await adapter.request({ id: 'task_test', name: 'Test Task', description: 'Find events' }, mock.state, mock.save);
  assert.equal(mock.state.stage, 'funds-confirmed');
  await adapter.submit(mock.state, 'answer\n"quoted"', mock.save);
  assert.equal(mock.state.resultHash, hashPaymentResult('answer\n"quoted"', mock.state.plan.identifierFromPurchaser));
  assert.deepEqual((await adapter.settle(mock.state, mock.save)).proof, { confirmed: true });
  assert.equal(mock.calls.filter(x => x === 'core-payment').length, 1);
  assert.ok(mock.calls.indexOf('payment-event-pending') < mock.calls.indexOf('core-payment'));
});

test('Standard adapter preserves nonce/input and returns seconds while hashing raw output', async () => {
  let plan;
  const mps = { async post(path, body) {
    if (path === 'payment') {
      const { createInputPaymentPlan } = await import('../scripts/payment.ts');
      plan = createInputPaymentPlan({ request: '{"interests":["payments"]}' }, body.identifierFromPurchaser, source,
        { nowMs: Date.parse(body.payByTime) - 15 * 60_000 });
      return { data: quote(plan) };
    }
    if (path === 'payment/submit-result') return { data: { ...quote(plan, true), NextAction: {
      requestedAction: 'SubmitResult', errorType: null, resultHash: body.submitResultHash,
    } } };
    return { data: quote(plan, true) };
  } };
  const adapter = createStandardAdapter({ source, mps, eve: { health: async () => {} } });
  const quoted = await adapter.quote({ id: '00000000-0000-4000-8000-000000000001', inputData: { request: '{"interests":["payments"]}' },
    identifierFromPurchaser: '01234567890123456789' });
  assert.equal(quoted.response.payByTime, Math.floor(Date.parse(plan.payByTime) / 1000));
  assert.equal(quoted.response.identifierFromPurchaser, plan.identifierFromPurchaser);
  assert.equal(await adapter.fundsLocked({ payment: quoted.payment }), true);
  const submitted = await adapter.submitResult({ payment: quoted.payment }, 'line\nnext');
  assert.equal(submitted.resultHash, hashMip004Result('line\nnext', plan.identifierFromPurchaser));
});

test('late receipt verification still proves an already-settled payment', async () => {
  const { createPaymentPlan } = await import('../scripts/payment.ts');
  const plan = createPaymentPlan({ taskId: 'old_task', name: 'Old Task', description: 'events' }, source, { nowMs: Date.now() - 90 * 60_000 });
  let reads = 0;
  const core = { async get() { reads += 1; return { data: { blockchainIdentifier: 'signed-terms-test', claimStatus: 'settled',
    onChainState: 'Withdrawn', settled: true, txHash: 'd'.repeat(64), withdrawnForSeller: [{ unit: TEST_USDM_UNIT, amount: '1000000' }] } }; } };
  const mps = { async post() { return { data: { ...quote(plan, true), onChainState: 'Withdrawn',
    CurrentTransaction: { status: 'Confirmed', txHash: 'd'.repeat(64), confirmations: 1 } } }; } };
  const adapter = createPaidAdapter({ source, core, mps, blockfrostKey: 'test-only', verify: async () => ({ confirmed: true }) });
  const state = { taskId: 'old_task', plan, quote: quote(plan) };
  assert.deepEqual((await adapter.settle(state, async () => {})).proof, { confirmed: true });
  assert.equal(reads, 1);
});

test('D8: empty Core payout summary still requires independent seller verification', async () => {
  const { createPaymentPlan } = await import('../scripts/payment.ts');
  const plan = createPaymentPlan({ taskId: 'task_test', name: 'Test', description: 'events' }, source);
  const core = { async get() { return { data: { blockchainIdentifier: 'signed-terms-test', claimStatus: 'PURCHASED',
    onChainState: 'Withdrawn', settled: true, txHash: 'd'.repeat(64), withdrawnForSeller: [] } }; } };
  const mps = { async post() { return { data: { ...quote(plan, true), onChainState: 'Withdrawn',
    CurrentTransaction: { status: 'Confirmed', txHash: 'd'.repeat(64), confirmations: 1 } } }; } };
  let checks = 0;
  const adapter = createPaidAdapter({ source, core, mps, blockfrostKey: 'test-only', verify: async (tx, checkedPlan) => {
    checks += 1;
    assert.equal(tx, 'd'.repeat(64));
    assert.equal(checkedPlan.source.sellerAddress, source.sellerAddress);
    throw new Error('Seller net amount differs from quote');
  } });
  await assert.rejects(adapter.settle({ taskId: 'task_test', plan, quote: quote(plan) }, async () => {}), /Seller net amount differs/);
  assert.equal(checks, 1);
});
