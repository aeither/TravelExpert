// Agent-to-agent buyer: Travel Expert pays another Masumi agent through its own MPS purchasing wallet.
// MIP-003 flow: /availability -> /start_job -> POST /purchase -> wait for FundsLocked -> /status -> result.
// Payment steps are code, never model decisions. Every external write is journaled first, and a purchase is
// looked up by its blockchainIdentifier before it is ever sent again.
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { TEST_USDM_UNIT } from './payment.ts';
import { createStore } from './worker-state.mjs';

const REQUEST_MS = 60_000;
const POLL_MS = 10_000;
const sha256 = text => createHash('sha256').update(text).digest('hex');
export const DEFAULT_MAX_AMOUNT = 1_000_000n; // 1 test USDM per job

function httpsOrLoopback(value, name) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))))
    throw new Error(`${name} must be https (or loopback http) without credentials.`);
  url.pathname = url.pathname.replace(/\/$/, '') + '/';
  return url;
}

export function createBuyerMps({ baseUrl, token, fetch: send = fetch }) {
  const base = httpsOrLoopback(baseUrl, 'MPS URL');
  if (!token?.trim() || /[\r\n]/.test(token)) throw new Error('Missing or invalid MPS token.');
  const allowed = new Set(['purchase', 'purchase/resolve-blockchain-identifier', 'purchase/request-refund']);
  return { async post(path, body) {
    if (!allowed.has(path)) throw new Error('Unsupported MPS purchase operation.');
    const response = await send(new URL(path, base), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(REQUEST_MS),
      headers: { token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(`MPS HTTP ${response.status}`), { status: response.status });
    return payload.data;
  } };
}

function sellerClient(sellerUrl, send) {
  const base = httpsOrLoopback(sellerUrl, 'Seller URL');
  async function call(path, init = {}) {
    const response = await send(new URL(path, base), { redirect: 'error', signal: AbortSignal.timeout(REQUEST_MS), ...init });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(`Seller HTTP ${response.status}`), { status: response.status });
    return payload;
  }
  return {
    availability: () => call('availability'),
    start: body => call('start_job', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    status: jobId => call(`status?${new URLSearchParams({ job_id: jobId })}`),
  };
}

// Sellers send deadlines in seconds or in milliseconds. Normalise to milliseconds.
export const toMs = value => { const n = Number(value); return n > 1e11 ? n : n * 1000; };

export function validateSellerQuote(quote, { agentIdentifier, nonce, amounts, maxAmount = DEFAULT_MAX_AMOUNT, nowSeconds = Math.floor(Date.now() / 1000) }) {
  if (typeof quote?.blockchainIdentifier !== 'string' || !quote.blockchainIdentifier) throw new Error('Seller quote has no blockchainIdentifier.');
  if (agentIdentifier && quote.agentIdentifier !== agentIdentifier) throw new Error('Seller quote is for a different agent than the one expected.');
  if (quote.identifierFromPurchaser !== nonce) throw new Error('Seller quote does not echo our purchaser identifier.');
  if (typeof quote.sellerVKey !== 'string' || !quote.sellerVKey) throw new Error('Seller quote has no seller key.');
  const times = ['payByTime', 'submitResultTime', 'unlockTime', 'externalDisputeUnlockTime'].map(key => Number(quote[key]));
  if (times.some(t => !Number.isInteger(t) || t <= 0)) throw new Error('Seller quote deadlines are missing.');
  const [payBy, submit, unlock, dispute] = times.map(toMs);
  if (payBy <= nowSeconds * 1000 || payBy >= submit || submit > unlock || unlock > dispute) throw new Error('Seller quote deadlines are inconsistent.');
  let total = 0n;
  for (const a of amounts) {
    if (a.unit !== TEST_USDM_UNIT && a.unit !== '') throw new Error('Only test USDM or ADA payments are allowed.');
    total += BigInt(a.amount);
  }
  if (total <= 0n || total > BigInt(maxAmount)) throw new Error('Amount is outside the per-job spending cap.');
  return { payBy, submit, unlock, dispute };
}

/**
 * Buys one job from another agent and returns { journal, result }.
 * `amounts` is the price the caller agrees to pay (from the seller's registry entry or /payment-information).
 */
export async function buyFromAgent({ sellerUrl, agentIdentifier, inputData, amounts = [{ unit: TEST_USDM_UNIT, amount: '1000000' }],
  maxAmount = DEFAULT_MAX_AMOUNT, mps, store, journalId, fetch: send = fetch, log = () => {}, pollMs = POLL_MS, now = () => Date.now(), verifyInputHash = true }) {
  const seller = sellerClient(sellerUrl, send);
  const id = journalId ?? `a2a_${randomBytes(6).toString('hex')}`;
  let j = await store.read(id) ?? { taskId: id, stage: 'new', sellerUrl, agentIdentifier, inputData, amounts, startedAt: new Date(now()).toISOString() };
  if (j.inspectionRequired) throw new Error(`A2A journal ${id} requires inspection before it can continue.`);
  const save = async stage => { j.stage = stage; await store.save(j); log(`a2a ${id}: ${stage}`); };

  if (j.stage === 'new') {
    const available = await seller.availability();
    if (available.status !== 'available') throw new Error('Seller reports it is not available.');
    j.nonce = randomBytes(8).toString('hex');
    await save('start-sent'); // saved before the write so an unknown outcome is never repeated blindly
    const quote = await seller.start({ identifier_from_purchaser: j.nonce, input_data: inputData });
    j.jobId = quote.job_id ?? quote.id;
    j.quote = quote;
    // The seller must have bound its terms to our exact request, or we do not pay.
    if (verifyInputHash && quote.input_hash !== sha256(`${j.nonce};${JSON.stringify(inputData)}`)) throw new Error('The seller quoted terms for a different request. Not paying.');
    validateSellerQuote(quote, { agentIdentifier, nonce: j.nonce, amounts, maxAmount, nowSeconds: Math.floor(now() / 1000) });
    await save('seller-quoted');
  } else if (j.stage === 'start-sent') {
    j.inspectionRequired = true; await store.save(j);
    throw new Error('A start_job request may have been sent. Inspect the seller job before retrying.');
  }

  const q = j.quote;
  // Echo the seller's signed terms unchanged; the contract rejects any altered field.
  const pr = q.payment_request;
  const purchaseBody = () => ({ network: 'Preprod', blockchainIdentifier: q.blockchainIdentifier, agentIdentifier: q.agentIdentifier, sellerVkey: q.sellerVKey,
    inputHash: q.input_hash ?? q.inputHash, identifierFromPurchaser: j.nonce, paymentSourceType: q.paymentSourceType ?? 'Web3CardanoV2',
    Amounts: amounts, payByTime: String(q.payByTime), submitResultTime: String(q.submitResultTime), unlockTime: String(q.unlockTime),
    externalDisputeUnlockTime: String(q.externalDisputeUnlockTime),
    ...(q.supportedPaymentSourceIndex !== undefined ? { supportedPaymentSourceIndex: q.supportedPaymentSourceIndex } : {}),
    ...(pr?.PaymentSource ? { PaymentSource: { network: 'Preprod', smartContractAddress: pr.PaymentSource.smartContractAddress, policyId: pr.PaymentSource.policyId } } : {}),
    ...(q.smartContractAddress ? { smartContractAddress: q.smartContractAddress } : {}) });
  const resolve = () => mps.post('purchase/resolve-blockchain-identifier', { network: 'Preprod', blockchainIdentifier: q.blockchainIdentifier });

  if (j.stage === 'seller-quoted' || j.stage === 'purchase-sending') {
    // MPS keys a purchase by blockchainIdentifier: look it up first so a restart never pays twice.
    let existing = null;
    if (j.stage === 'purchase-sending') { try { existing = await resolve(); } catch (error) { if (error.status !== 404) throw error; } }
    if (!existing) {
      await save('purchase-sending');
      try { existing = await mps.post('purchase', purchaseBody()); }
      catch (error) { j.inspectionRequired = true; await store.save(j); throw new Error(`Purchase outcome unknown (${error.message}). Inspect MPS before retrying.`); }
    }
    j.purchaseId = existing?.id ?? null;
    await save('purchased');
  }

  if (j.stage === 'purchased') {
    while (now() < toMs(q.submitResultTime)) {
      // A new purchase is invisible to a wallet-scoped key until MPS's lock cycle assigns it a wallet, so 404 means "not yet".
      let p = null;
      try { p = await resolve(); } catch (error) { if (error.status !== 404) throw error; }
      if (p?.onChainState === 'FundsLocked' && p.CurrentTransaction?.status === 'Confirmed') { j.fundsLockedTx = p.CurrentTransaction.txHash; break; }
      if (p?.NextAction?.errorType) { j.inspectionRequired = true; await store.save(j); throw new Error('MPS reported a purchase error. Inspect the payment.'); }
      await delay(pollMs);
    }
    if (!j.fundsLockedTx) { j.inspectionRequired = true; await store.save(j); throw new Error('Funds were not confirmed before the result deadline.'); }
    await save('funds-locked');
  }

  if (j.stage === 'funds-locked') {
    while (now() < toMs(q.submitResultTime)) {
      const s = await seller.status(j.jobId);
      if (s.status === 'completed') { j.result = s.result ?? s.output ?? null; j.completedAt = new Date(now()).toISOString(); await save('completed'); break; }
      if (s.status === 'failed') { await save('seller-failed'); break; }
      await delay(pollMs);
    }
    if (j.stage === 'funds-locked') await save('deadline-passed');
  }

  if (j.stage === 'deadline-passed' || j.stage === 'seller-failed') {
    // The seller did not deliver in time: ask MPS for the refund instead of leaving the escrow locked.
    await mps.post('purchase/request-refund', { network: 'Preprod', blockchainIdentifier: q.blockchainIdentifier });
    await save('refund-requested');
  }
  return { journal: j, result: j.stage === 'completed' ? j.result : null };
}

export async function openA2aStore(directory) { return createStore(directory); }
