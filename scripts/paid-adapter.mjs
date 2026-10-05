import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createPaymentPlan, createSignedQuote, buildMasumiPaymentEvent, waitForFundsLocked,
  submitSellerResult, fetchCoreReceipt, validatePlan, validateQuote, readSellerCollection } from './payment.ts';
import { verifySellerPayment } from './chain.ts';

const RECEIPT_POLL_MS = 10_000;
const COLLECTION_GRACE_MS = 30 * 60_000;

export function createPaidAdapter({ source, mps, core, blockfrostKey, verify = verifySellerPayment, pause = delay, signal }) {
  return {
    async request(task, state, save) {
      state.plan = createPaymentPlan({ taskId: task.id, name: task.name, description: task.description }, source);
      await save('quote-pending');
      state.quote = await createSignedQuote(mps, state.plan, signal);
      await save('quote-saved');
      const event = buildMasumiPaymentEvent(state.plan, state.quote);
      await save('payment-event-pending');
      state.paymentEventId = await core.payment(task.id, event);
      await save('payment-event-saved');
      state.fundedPayment = await waitForFundsLocked(mps, state.plan, state.quote, signal);
      await save('funds-confirmed');
    },
    async submit(state, text, save) {
      validatePlan(state.plan);
      validateQuote(state.plan, state.quote);
      await save('result-hash-pending');
      const result = await submitSellerResult(mps, state.plan, state.fundedPayment, text, signal);
      state.resultHash = result.resultHash;
      await save('result-hash-submitted');
    },
    async settle(state, save) {
      validatePlan(state.plan);
      validateQuote(state.plan, state.quote);
      await save('collection-pending');
      const stopAt = Date.parse(state.plan.externalDisputeUnlockTime) + COLLECTION_GRACE_MS;
      while (true) {
        signal?.throwIfAborted();
        const receipt = await fetchCoreReceipt(core, state.taskId, signal);
        const payment = await readSellerCollection(mps, state.plan, state.quote, signal);
        if (receipt.blockchainIdentifier && receipt.blockchainIdentifier !== state.quote.blockchainIdentifier) {
          throw new Error('Core receipt belongs to another payment.');
        }
        if (receipt.settled && receipt.txHash && payment.settled && payment.txHash === receipt.txHash) {
          if (receipt.blockchainIdentifier !== state.quote.blockchainIdentifier) throw new Error('Receipt has no matching payment identifier.');
          const proof = await verify(receipt.txHash, state.plan, blockfrostKey, signal);
          return { receipt, proof };
        }
        if (Date.now() >= stopAt) break;
        await pause(RECEIPT_POLL_MS, undefined, { signal });
      }
      throw new Error('Seller collection is pending. Resume receipt verification for the same Task.');
    },
  };
}

export async function resumeReceipt(taskId, { store, payments, runtime, coworkerId }) {
  const state = await store.read(taskId);
  if (!state || state.coworkerId !== coworkerId || state.executionOnly || !state.eventId ||
      !['task-completed', 'collection-pending'].includes(state.stage)) {
    throw new Error('Receipt verification requires a completed paid Task journal.');
  }
  const detail = await runtime.inspect(taskId);
  if (detail.task.id !== taskId || detail.task.status !== 'COMPLETED' || detail.task.organizationId !== null ||
      (detail.task.assigneeId ?? detail.task.coworkerId) !== coworkerId) throw new Error('Completed Task identity differs from the journal.');
  const text = await readFile(state.resultFile, 'utf8');
  const { hashPaymentResult } = await import('./payment.ts');
  if (hashPaymentResult(text, state.plan.identifierFromPurchaser) !== state.resultHash) throw new Error('Saved result differs from the submitted hash.');
  const save = async stage => { state.stage = stage; await store.save(state); };
  state.paymentProof = await payments.settle(state, save);
  state.inspectionRequired = false;
  await save('completed');
  return state.paymentProof;
}
