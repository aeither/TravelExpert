import { createInputPaymentPlan, createSignedQuote, readPayment, submitStandardResult,
  validatePlan, validateQuote } from './payment.ts';
import { eveJobRunner } from './agent-api.mjs';

export function createStandardAdapter({ source, mps, eve }) {
  return {
    registrationVerified: true,
    async modelHealth() { await eve.health(); return true; },
    async quote({ id, inputData, identifierFromPurchaser }) {
      const plan = createInputPaymentPlan(inputData, identifierFromPurchaser, source);
      const quote = await createSignedQuote(mps, plan);
      const seconds = key => Math.floor(Number(quote[key]) / 1000);
      return {
        response: { id, blockchainIdentifier: quote.blockchainIdentifier, payByTime: seconds('payByTime'),
          submitResultTime: seconds('submitResultTime'), unlockTime: seconds('unlockTime'),
          externalDisputeUnlockTime: seconds('externalDisputeUnlockTime'), agentIdentifier: quote.agentIdentifier,
          sellerVKey: quote.SmartContractWallet.walletVkey, identifierFromPurchaser, input_hash: quote.inputHash },
        payment: { plan, quote },
      };
    },
    async fundsLocked(job) {
      const plan = validatePlan(job.payment.plan);
      const quote = validateQuote(plan, job.payment.quote);
      if (Date.now() >= Date.parse(plan.submitResultTime)) throw new Error('Job result deadline expired. Inspect the existing payment.');
      const current = await readPayment(mps, plan, quote);
      if (current.onChainState !== null && current.onChainState !== 'FundsLocked') throw new Error('Unexpected payment state.');
      return current.onChainState === 'FundsLocked' && current.CurrentTransaction?.status === 'Confirmed' &&
        !!current.CurrentTransaction.txHash && (current.CurrentTransaction.confirmations ?? 0) > 0;
    },
    runAgent: eveJobRunner(eve),
    async submitResult(job, result) {
      const submitted = await submitStandardResult(mps, job.payment.plan, job.payment.quote, result);
      return { confirmed: true, resultHash: submitted.resultHash, paymentId: submitted.payment.id };
    },
  };
}
