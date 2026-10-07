import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWallets, runPreflight, MIN } from '../scripts/preflight.mjs';

const USDM = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';
const wallet = (ada, usdm) => ({ amount: [{ unit: 'lovelace', quantity: String(Math.round(ada * 1e6)) }, ...(usdm === undefined ? [] : [{ unit: USDM, quantity: String(Math.round(usdm * 1e6)) }])] });

test('a funded seller and buyer pass and report how many tasks the buyer can still pay for', () => {
  const r = evaluateWallets({ seller: wallet(108, 126), buyer: wallet(74, 85) });
  assert.equal(r.ok, true);
  assert.equal(r.problems.length, 0);
  assert.equal(r.buyer.tasksLeft, Math.floor(85 / 3));
});

test('a seller below the collateral minimum is a blocking problem that names the fix', () => {
  const r = evaluateWallets({ seller: wallet(5.6, 126), buyer: wallet(74, 85) });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /seller wallet/i); assert.match(r.problems[0], /dispenser\.masumi\.network/);
});

test('a buyer that cannot pay for one more task is a problem, a low one is a warning', () => {
  assert.equal(evaluateWallets({ seller: wallet(100, 100), buyer: wallet(40, 2) }).ok, false);
  const low = evaluateWallets({ seller: wallet(100, 100), buyer: wallet(40, 9) });
  assert.equal(low.ok, true); assert.ok(low.warnings.length >= 1);
  assert.ok(MIN.sellerAda >= 7);
});

test('preflight combines wallets and service checks and never throws on a failing check', async () => {
  const fetcher = async url => String(url).includes('blockfrost') ? Response.json(wallet(100, 100)) : String(url).includes('bad') ? (() => { throw new Error('down'); })() : Response.json({ status: 'available' });
  const out = await runPreflight({ env: { BLOCKFROST_API_KEY_PREPROD: 'k', SELLER_ADDRESS: 'addr_s', BUYER_ADDRESS: 'addr_b', ORIGIN_API_URL: 'https://ok.example.com', TRAVEL_EXPERT_URL: 'https://bad.example.com' }, fetch: fetcher });
  assert.equal(out.ok, false);
  assert.ok(out.checks.some(c => c.name === 'origin-api' && c.ok));
  assert.ok(out.checks.some(c => c.name === 'travel-expert' && !c.ok));
});
