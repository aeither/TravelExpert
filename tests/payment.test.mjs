import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildMasumiPaymentEvent, createMpsClient, createPaymentPlan, createSignedQuote, DEFAULT_PAYMENT_AMOUNT,
  fetchCoreReceipt, hashPaymentInput, hashPaymentResult, submitSellerResult, TEST_USDM_UNIT, validatePlan,
  validateQuote, waitForFundsLocked, hashMip004Result, hashCanonicalInput, createInputPaymentPlan,
  submitStandardResult, readSellerCollection, verifySellerNetReceipt } from '../scripts/payment.ts';

const source = { agentIdentifier: 'a'.repeat(56) + '01', policyId: 'a'.repeat(56),
  smartContractAddress: 'addr_test1wqqqqqq', sellerVkey: 'b'.repeat(56), sellerAddress: 'addr_test1qqqqqqq', supportedPaymentSourceIndex: 0 };
const task = { taskId: 'one', name: 'Tiny Eve', description: 'line\n"quote"' };
const plan = () => createPaymentPlan(task, source);
function quote(p) {
  return { id: 'payment-one', blockchainIdentifier: 'signed-terms', agentIdentifier: p.source.agentIdentifier,
    pricingType: 'Dynamic', inputHash: p.inputHash, payByTime: String(Date.parse(p.payByTime)),
    submitResultTime: String(Date.parse(p.submitResultTime)), unlockTime: String(Date.parse(p.unlockTime)),
    externalDisputeUnlockTime: String(Date.parse(p.externalDisputeUnlockTime)), sellerReturnAddress: null, buyerReturnAddress: null,
    forceLayer: null, RequestedFunds: [{ amount: p.amount, unit: p.unit }], SmartContractWallet: { walletVkey: source.sellerVkey, walletAddress: source.sellerAddress },
    PaymentSource: { network: 'Preprod', paymentSourceType: 'Web3CardanoV2', policyId: source.policyId, smartContractAddress: source.smartContractAddress },
    onChainState: null, resultHash: '', NextAction: { requestedAction: 'WaitingForExternalAction', errorType: null, resultHash: null }, CurrentTransaction: null };
}
function locked(p) {
  return { ...quote(p), onChainState: 'FundsLocked', CurrentTransaction: { status: 'Confirmed', txHash: 'c'.repeat(64), confirmations: 1 } };
}
function mockClient(responses) {
  const calls = [];
  const client = { async post(path, body) { calls.push({ path, body });
    if (!responses.length) throw new Error('Unexpected operation');
    return { data: responses.shift() };
  } };
  return { client, calls };
}
test('plan fixes Preprod V2 test USDM and preserves nonce, hashes and terms when persisted', () => {
  const p = createPaymentPlan(task, source, { nowMs: 1790000000000 });
  assert.equal(p.amount, DEFAULT_PAYMENT_AMOUNT);
  assert.equal(p.unit, TEST_USDM_UNIT);
  assert.deepEqual(validatePlan(JSON.parse(JSON.stringify(p))), p);
  assert.deepEqual(createPaymentPlan(task, source, { nowMs: 1790000000000 }), p);
  assert.notEqual(createPaymentPlan({ ...task, taskId: 'two' }, source).identifierFromPurchaser, p.identifierFromPurchaser);
  assert.equal(Date.parse(p.submitResultTime) - 1790000000000, 20 * 60_000);
  assert.equal(Date.parse(p.unlockTime) - 1790000000000, 36 * 60_000);
  assert.equal(Date.parse(p.externalDisputeUnlockTime) - 1790000000000, 52 * 60_000);
});
test('local Sokosumi compatibility hash uses escaped result with nonce delimiter', () => {
  const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
  const nonce = '01234567890123456789';
  const canonical = '{"description":"line\\n\\\"quote\\\"","name":"Tiny Eve","taskId":"one"}';
  assert.equal(hashPaymentInput(task, nonce), sha(`${nonce};${canonical}`));
  const result = 'hello\n"world"\\end';
  assert.equal(hashPaymentResult(result, nonce), sha(`${nonce};hello\\n\\\"world\\\"\\\\end`));
  assert.notEqual(hashPaymentResult(result, nonce), sha(result));
});

test('MIP004 raw output and local Core compatibility differ on escaped text', () => {
  const sha = s => createHash('sha256').update(s, 'utf8').digest('hex');
  const nonce = '01234567890123456789';
  for (const result of ['hello\n"world"\\end', '😀\tline\r', 'plain text']) {
    assert.equal(hashMip004Result(result, nonce), sha(`${nonce};${result}`));
  }
  assert.notEqual(hashMip004Result('line\nnext', nonce), hashPaymentResult('line\nnext', nonce));
});

test('canonical JSON sorts nested keys, preserves array order, and rejects non-JSON input', () => {
  const nonce = '01234567890123456789';
  const a = { z: [true, -0, { b: '😀', a: null }], a: 1.5 };
  const canonical = '{"a":1.5,"z":[true,0,{"a":null,"b":"😀"}]}';
  assert.equal(hashCanonicalInput(a, nonce), createHash('sha256').update(`${nonce};${canonical}`).digest('hex'));
  for (const value of [{ a: undefined }, { a: NaN }, { a: '\ud800' }, new Date(), [undefined]])
    assert.throws(() => hashCanonicalInput(value, nonce));
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => hashCanonicalInput(cycle, nonce));
  assert.throws(() => hashPaymentResult('\ud800', nonce));
});

test('Standard input plan binds exact submitted input and purchaser nonce', () => {
  const input = { interests: ['stablecoins'], availableUntil: '16:00' };
  const nonce = '01234567890123456789';
  const p = createInputPaymentPlan(input, nonce, source);
  assert.equal(p.inputHash, hashCanonicalInput(input, nonce));
  assert.equal(p.identifierFromPurchaser, nonce);
  assert.deepEqual(p.input, input);
});

test('Standard result submits raw MIP004 hash; collection reads and independent receipt exclude false proof', async () => {
  const p = plan(), q = quote(p), result = 'line\nnext';
  const hash = hashMip004Result(result, p.identifierFromPurchaser);
  const accepted = { ...locked(p), NextAction: { requestedAction: 'SubmitResultRequested', errorType: null, resultHash: hash } };
  const { client, calls } = mockClient([locked(p), accepted]);
  assert.equal((await submitStandardResult(client, p, q, result)).resultHash, hash);
  assert.equal(calls[1].body.submitResultHash, hash);
  const pending = mockClient([locked(p)]);
  assert.equal((await readSellerCollection(pending.client, p, q)).settled, false);
  const paid = mockClient([{ ...locked(p), onChainState: 'Withdrawn' }]);
  assert.equal((await readSellerCollection(paid.client, p, q)).settled, true);
  const txHash = 'c'.repeat(64);
  const amount = quantity => [{ unit: TEST_USDM_UNIT, quantity }];
  const utxos = { hash: txHash, inputs: [{ address: source.sellerAddress, amount: amount('100') }],
    outputs: [{ address: source.sellerAddress, amount: amount('950100') }] };
  assert.equal(verifySellerNetReceipt(txHash, source.sellerAddress, utxos).netAmount, '950000');
  assert.throws(() => verifySellerNetReceipt('d'.repeat(64), source.sellerAddress, utxos));
  assert.throws(() => verifySellerNetReceipt(txHash, source.sellerAddress, { ...utxos, outputs: [] }));
});
test('invalid price, network, unit, hash and timing fail plan validation', () => {
  const p = plan();
  for (const amount of ['0', '-1', '1.5', '1e6', '100000000000000000000'])
    assert.throws(() => createPaymentPlan(task, source, { amount }));
  for (const patch of [{ network: 'Mainnet' }, { paymentSourceType: 'Web3CardanoV1' }, { unit: '' },
    { inputHash: '0'.repeat(64) }, { unlockTime: p.submitResultTime }]) assert.throws(() => validatePlan({ ...p, ...patch }));
});
test('quotes reject funds, seller, source, deadline and signed override changes', () => {
  const p = plan(), q = quote(p);
  const changes = [{ RequestedFunds: [{ amount: '2000000', unit: TEST_USDM_UNIT }] },
    { RequestedFunds: [{ amount: p.amount, unit: '' }] }, { pricingType: 'Fixed' },
    { agentIdentifier: 'd'.repeat(58) }, { SmartContractWallet: { ...q.SmartContractWallet, walletVkey: 'd'.repeat(56) } },
    { PaymentSource: { ...q.PaymentSource, network: 'Mainnet' } },
    { PaymentSource: { ...q.PaymentSource, smartContractAddress: 'addr_test1w22222' } },
    { submitResultTime: '1790000000000' }, { sellerReturnAddress: source.sellerAddress },
    { forceLayer: 'L1' }, { paymentForceLayer: 'Hydra' }, { inputHash: '0'.repeat(64) }];
  for (const change of changes) assert.throws(() => validateQuote(p, { ...q, ...change }));
});
test('signed quote sends explicit Dynamic funds and Core event only carries supported fields', async () => {
  const p = plan(), q = quote(p), { client, calls } = mockClient([q]);
  assert.deepEqual(await createSignedQuote(client, p), q);
  assert.equal(calls[0].path, 'payment');
  const sent = calls[0].body;
  assert.deepEqual(sent.RequestedFunds, [{ amount: p.amount, unit: TEST_USDM_UNIT }]);
  assert.equal(sent.sellerReturnAddress, undefined);
  assert.equal(sent.forceLayer, undefined);
  const event = buildMasumiPaymentEvent(p, q);
  assert.deepEqual(event.masumiPayment.Amounts, q.RequestedFunds);
  assert.equal(event.masumiPayment.sellerVkey, source.sellerVkey);
  assert.equal('credits' in event, false);
  assert.equal('status' in event, false);
  assert.equal('sellerReturnAddress' in event.masumiPayment, false);
});
test('expired plan fails before quote or event submission', async () => {
  const p = createPaymentPlan(task, source, { nowMs: 1790000000000 }), { client, calls } = mockClient([]);
  await assert.rejects(createSignedQuote(client, p), /expired/);
  assert.throws(() => buildMasumiPaymentEvent(p, quote(p)), /expired/);
  assert.equal(calls.length, 0);
});
test('result submission checks confirmed funds before sending the nonce-bound hash', async () => {
  const p = plan(), q = quote(p), result = 'real Eve answer';
  const hash = hashPaymentResult(result, p.identifierFromPurchaser);
  const accepted = { ...locked(p), NextAction: { requestedAction: 'SubmitResultRequested', errorType: null, resultHash: hash } };
  const { client, calls } = mockClient([locked(p), locked(p), accepted]);
  await waitForFundsLocked(client, p, q);
  const submitted = await submitSellerResult(client, p, q, result);
  assert.equal(submitted.resultHash, hash);
  assert.deepEqual(calls.map(c => c.path), ['payment/resolve-blockchain-identifier', 'payment/resolve-blockchain-identifier', 'payment/submit-result']);
  assert.deepEqual(calls[2].body, { network: 'Preprod', blockchainIdentifier: q.blockchainIdentifier, submitResultHash: hash });
});
test('unconfirmed or wrong payment fails before result submission', async () => {
  const p = plan(), q = quote(p);
  for (const current of [q, { ...locked(p), CurrentTransaction: { ...locked(p).CurrentTransaction, confirmations: 0 } },
    { ...locked(p), blockchainIdentifier: 'different' }, { ...locked(p), resultHash: 'd'.repeat(64) }]) {
    const { client, calls } = mockClient([current]);
    await assert.rejects(submitSellerResult(client, p, q, 'answer'));
    assert.deepEqual(calls.map(c => c.path), ['payment/resolve-blockchain-identifier']);
  }
});
test('same accepted result can resume without a second seller submission', async () => {
  const p = plan(), hash = hashPaymentResult('answer', p.identifierFromPurchaser);
  const current = { ...locked(p), resultHash: hash, onChainState: 'ResultSubmitted' };
  const { client, calls } = mockClient([current]);
  assert.equal((await submitSellerResult(client, p, quote(p), 'answer')).resultHash, hash);
  assert.equal(calls.length, 1);
});
test('MPS uses token auth, refuses redirects, and sanitizes failures', async () => {
  const secret = 'test-secret';
  let init;
  const send = async (_url, options) => { init = options; return new Response('{}', { status: 200 }); };
  const client = createMpsClient({ baseUrl: 'http://127.0.0.1:3012/api/v1', token: secret, fetch: send });
  await client.post('payment', {});
  assert.equal(init?.redirect, 'error');
  assert.equal(init?.headers.token, secret);
  assert.throws(() => createMpsClient({ baseUrl: 'http://external.example/api/v1', token: secret }));
  const broken = async () => { throw new Error(`redirect ${secret}`); };
  await assert.rejects(createMpsClient({ baseUrl: 'https://mps.example/api/v1', token: secret, fetch: broken }).post('payment', {}), e =>
    e instanceof Error && !e.message.includes(secret) && e.message.includes('outcome unknown'));
});
test('receipt uses deployed Core path and validates the response', async () => {
  const receipt = { blockchainIdentifier: null, claimStatus: null, onChainState: null, settled: false, txHash: null, withdrawnForSeller: [] };
  const paths = [];
  assert.deepEqual(await fetchCoreReceipt({ async get(path) { paths.push(path); return { data: receipt }; } }, 'task/one'), receipt);
  assert.deepEqual(paths, ['/v1/tasks/task%2Fone/receipt']);
  await assert.rejects(fetchCoreReceipt({ async get() { return { data: { ...receipt, settled: 'yes' } }; } }, 'one'));
});

test('settled receipt must include a real transaction and positive test USDM seller payout', async () => {
  const receipt = { blockchainIdentifier: 'signed-terms', claimStatus: 'PURCHASED', onChainState: 'Withdrawn',
    settled: true, txHash: 'c'.repeat(64), withdrawnForSeller: [{ unit: TEST_USDM_UNIT, amount: '950000' }] };
  assert.deepEqual(await fetchCoreReceipt({ async get() { return { data: receipt }; } }, 'one'), receipt);
  for (const patch of [{ txHash: null }, { onChainState: 'FundsLocked' },
    { withdrawnForSeller: [{ unit: '', amount: '1000000' }] }, { withdrawnForSeller: [{ unit: TEST_USDM_UNIT, amount: '0' }] }])
    await assert.rejects(fetchCoreReceipt({ async get() { return { data: { ...receipt, ...patch } }; } }, 'one'), /does not prove/);
});

test('D8: ordinary Withdrawn receipt can omit the dispute payout summary', async () => {
  const receipt = { blockchainIdentifier: 'signed-terms', claimStatus: 'PURCHASED', onChainState: 'Withdrawn',
    settled: true, txHash: 'c'.repeat(64), withdrawnForSeller: [] };
  assert.deepEqual(await fetchCoreReceipt({ async get() { return { data: receipt }; } }, 'one'), receipt);
  await assert.rejects(fetchCoreReceipt({ async get() { return { data: { ...receipt, onChainState: 'DisputedWithdrawn' } }; } }, 'one'), /does not prove/);
});

test('D13: funding read crossing result deadline cannot authorize paid model execution', async () => {
  const p = plan(), q = quote(p), original = Date.now;
  try {
    const client = { post: async () => { Date.now = () => Date.parse(p.submitResultTime); return { data: locked(p) }; } };
    await assert.rejects(waitForFundsLocked(client, p, q), /deadline|expired/i);
  } finally { Date.now = original; }
});
