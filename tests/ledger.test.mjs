import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger } from '../scripts/ledger.mjs';
import { renderReceipt, renderReceiptFor, readLedgerEvidence } from '../scripts/receipt.mjs';

const open = async () => openLedger(await mkdtemp(join(tmpdir(), 'ledger-')));
const T = 'task_abcdef12';

test('an unknown task has an empty ledger', async () => {
  const ledger = await open();
  assert.deepEqual(await ledger.read(T), { taskRef: T, purchases: [], evidence: { hotels: [], flights: [], knowledge: [] } });
  assert.equal(await ledger.spent(T), 0n);
});

test('purchases are recorded and updated; failures and free fallbacks do not count as spent', async () => {
  const ledger = await open();
  await ledger.recordPurchase(T, { id: 'a', service: 'hotel-search', priceAtomic: '1000000', status: 'started' });
  await ledger.recordPurchase(T, { id: 'b', service: 'knowledge', priceAtomic: '500000', status: 'started' });
  await ledger.recordPurchase(T, { id: 'c', service: 'knowledge', priceAtomic: '500000', status: 'failed' });
  await ledger.recordPurchase(T, { id: 'd', service: 'knowledge', priceAtomic: '0', status: 'unpaid-fallback' });
  assert.equal(await ledger.spent(T), 1_500_000n);
  const updated = await ledger.updatePurchase(T, 'a', { status: 'completed', escrowTx: 'e', resultTx: 'r' });
  assert.equal(updated.status, 'completed');
  assert.equal((await ledger.read(T)).purchases[0].escrowTx, 'e');
  await assert.rejects(ledger.updatePurchase(T, 'zz', {}), /No purchase/);
  await assert.rejects(ledger.recordPurchase(T, { service: 'audit' }), /needs an id/);
});

test('evidence is appended without duplicates and only for known kinds', async () => {
  const ledger = await open();
  await ledger.addEvidence(T, 'hotels', { name: 'A', total: 90 });
  await ledger.addEvidence(T, 'hotels', { name: 'A', total: 90 });
  await ledger.addEvidence(T, 'knowledge', 'Rainy season runs to December.');
  const { evidence } = await ledger.read(T);
  assert.equal(evidence.hotels.length, 1);
  assert.deepEqual(evidence.knowledge, ['Rainy season runs to December.']);
  await assert.rejects(ledger.addEvidence(T, 'prices', 1), /Unknown evidence/);
});

test('writes made at the same time are all kept, and the task reference must be a safe id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-')); const ledger = await openLedger(dir);
  await Promise.all(Array.from({ length: 12 }, (_, i) => ledger.recordPurchase(T, { id: `p${i}`, service: 'knowledge', priceAtomic: '1', status: 'completed' })));
  assert.equal((await ledger.read(T)).purchases.length, 12);
  await assert.rejects(ledger.read('../escape'), /Invalid/);
  assert.deepEqual(await readdir(dir), [`${T}.json`]);
});

test('the receipt lists every hired agent with explorer links, and never calls a pending payout collected', async () => {
  const ledger = await open();
  await ledger.recordPurchase(T, { id: 'a', service: 'hotel-search', seller: 'Expert Travel Agency', priceAtomic: '1000000', status: 'completed', escrowTx: 'e1', resultTx: 'r1' });
  await ledger.recordPurchase(T, { id: 'b', service: 'knowledge', priceAtomic: '500000', status: 'completed', escrowTx: 'e2', resultTx: 'r2', collectionTx: 'c2' });
  await ledger.recordPurchase(T, { id: 'c', service: 'audit', seller: 'Trip Auditor', priceAtomic: '500000', status: 'refund-requested', escrowTx: 'e3' });
  await ledger.recordPurchase(T, { id: 'd', service: 'knowledge', priceAtomic: '0', status: 'unpaid-fallback' });
  const text = renderReceipt(await ledger.read(T));
  assert.match(text, /Hotel search \| Expert Travel Agency \| 1 test USDM \| delivered \| \[escrow\]\(https:\/\/preprod\.cexplorer\.io\/tx\/e1\) \| \[result\]\(https:\/\/preprod\.cexplorer\.io\/tx\/r1\) \| payout pending/);
  assert.match(text, /\[collected\]\(https:\/\/preprod\.cexplorer\.io\/tx\/c2\)/);
  assert.match(text, /Plan audit \| Trip Auditor \| 0.5 test USDM \| refund requested/);
  assert.match(text, /answered without payment/);
  assert.match(text, /Spent 2 test USDM of a 4 test USDM cap/);
  assert.equal(renderReceipt({ purchases: [] }), '');
});

test('receipt and evidence helpers read the ledger under DATA_DIR', async () => {
  const data = await mkdtemp(join(tmpdir(), 'data-'));
  const ledger = await openLedger(join(data, 'ledger'));
  const env = { DATA_DIR: data, A2A_TASK_CAP_ATOMIC: '2000000' };
  assert.equal(await renderReceiptFor(T, env), '');
  await ledger.recordPurchase(T, { id: 'a', service: 'audit', priceAtomic: '500000', status: 'completed', escrowTx: 'e' });
  await ledger.addEvidence(T, 'flights', { summary: 'SIN→CEB', total: 200, currency: 'USD' });
  assert.match(await renderReceiptFor(T, env), /Spent 0.5 test USDM of a 2 test USDM cap/);
  assert.deepEqual((await readLedgerEvidence(T, env)).flights, [{ summary: 'SIN→CEB', total: 200, currency: 'USD' }]);
});
