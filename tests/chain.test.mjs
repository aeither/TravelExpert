import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sellerNetUnits, verifySellerPayment } from '../scripts/chain.ts';
import { TEST_USDM_UNIT, createPaymentPlan } from '../scripts/payment.ts';

const row = (address, quantity, extra = {}) => ({ address, amount: [{ unit: TEST_USDM_UNIT, quantity }], ...extra });
const sellerAddress = 'addr_test1qqqqqqq';
const source = { agentIdentifier: 'a'.repeat(56) + '01', policyId: 'a'.repeat(56), smartContractAddress: 'addr_test1wqqqqqq',
  sellerVkey: 'b'.repeat(56), sellerAddress, supportedPaymentSourceIndex: 0 };
const plan = () => createPaymentPlan({ taskId: 'one', name: 'Guide', description: 'Events' }, source);
const txHash = 'c'.repeat(64);

test('seller proof subtracts change and excludes collateral and reference inputs', () => {
  assert.equal(sellerNetUnits({ inputs: [row('seller', '2000000'), row('seller', '9000000', { reference: true }),
    row('seller', '9000000', { collateral: true })], outputs: [row('seller', '3000000'), row('buyer', '7000000')] }, 'seller'), 1000000n);
  assert.equal(sellerNetUnits({ inputs: [row('seller', '2000000')], outputs: [row('seller', '2000000')] }, 'seller'), 0n);
});

function chainFetch(patch = {}) {
  const calls = [];
  return { calls, fetch: async (url, init) => {
    calls.push({ url, init });
    const data = url.endsWith('/utxos') ? { inputs: [], outputs: [row(sellerAddress, patch.amount ?? '1000000')] } :
      url.endsWith('/latest') ? { height: patch.height ?? 102 } : { hash: txHash, valid_contract: true, block_height: 100, ...patch.tx };
    return new Response(JSON.stringify(data));
  } };
}

test('read-only chain verification binds transaction, seller, exact amount, and confirmations', async () => {
  const mock = chainFetch();
  const proof = await verifySellerPayment(txHash, plan(), 'preprodTestKey', undefined, mock);
  assert.equal(proof.confirmations, 3);
  assert.equal(proof.sellerNetUnits, '1000000');
  assert.equal(mock.calls.length, 3);
  assert.ok(mock.calls.every(call => call.url.startsWith('https://cardano-preprod.blockfrost.io/api/v0/') &&
    call.init.redirect === 'error' && call.init.headers.project_id === 'preprodTestKey'));
});

test('wrong transaction, invalid script, short payment, and unconfirmed block fail proof', async () => {
  for (const patch of [{ tx: { hash: 'd'.repeat(64) } }, { tx: { valid_contract: false } }, { amount: '999999' }, { height: 99 }]) {
    await assert.rejects(verifySellerPayment(txHash, plan(), 'preprodTestKey', undefined, chainFetch(patch)));
  }
});

test('chain transport errors do not expose credentials', async () => {
  await assert.rejects(verifySellerPayment(txHash, plan(), 'preprodTestKey', undefined, {
    fetch: async () => { throw new Error('preprodTestKey'); },
  }), error => !error.message.includes('preprodTestKey') && error.message.includes('not determined'));
});
