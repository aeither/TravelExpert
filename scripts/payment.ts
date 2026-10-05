import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

export const TEST_USDM_UNIT = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';
export const DEFAULT_PAYMENT_AMOUNT = '1000000';
const MINUTE_MS = 60_000;
const REQUEST_MS = 30_000;
const POLL_MS = 5_000;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const hexKey = z.string().regex(/^[0-9a-f]{56}$/);
const timestamp = z.string().regex(/^[1-9]\d{0,18}$/);
const preprodAddress = z.string().max(250).regex(/^addr_test1[023456789acdefghjklmnpqrstuvwxyz]+$/);
const taskSchema = z.object({ taskId: z.string().min(1), name: z.string().min(1), description: z.string().nullable() });
const sourceSchema = z.object({
  agentIdentifier: z.string().min(57).max(250).regex(/^[0-9a-f]+$/),
  policyId: hexKey,
  smartContractAddress: preprodAddress,
  sellerVkey: hexKey,
  sellerAddress: preprodAddress,
  supportedPaymentSourceIndex: z.number().int().min(0).max(24),
});
export type PaymentTask = z.infer<typeof taskSchema>;
export type PaymentSource = z.infer<typeof sourceSchema>;

// VERIFIED: MIP-004 input uses RFC 8785 JSON with a nonce and semicolon.
// This canonicalizer accepts JSON values only; it rejects invalid Unicode and non-JSON types.
function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    if (!value.isWellFormed()) throw new Error('Payment data contains invalid Unicode');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('Payment input must contain only finite JSON values');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Payment input must use plain JSON objects');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${Array.from(value, item => canonicalJson(item, ancestors)).join(',')}]`;
    const entries = Object.keys(value).sort().map(key => `${canonicalJson(key)}:${canonicalJson((value as Record<string, unknown>)[key], ancestors)}`);
    return `{${entries.join(',')}}`;
  } finally { ancestors.delete(value); }
}
function validateNonce(nonce: string) {
  if (!/^[0-9a-f]{14,26}$/.test(nonce)) throw new Error('Invalid purchaser nonce');
}
export function hashCanonicalInput(input: unknown, nonce: string): string {
  validateNonce(nonce);
  return sha256(`${nonce};${canonicalJson(input)}`);
}
export function hashPaymentInput(input: PaymentTask, nonce: string): string {
  const task = taskSchema.parse(input);
  return hashCanonicalInput(task, nonce);
}
export function hashPaymentResult(result: string, nonce: string): string {
  validateNonce(nonce);
  if (typeof result !== 'string' || !result.isWellFormed()) throw new Error('Seller result must be valid Unicode text');
  // VERIFIED: inspected local Sokosumi packages/masumi/src/hash/hash.ts:76 escapes result text.
  // The deployed Core implementation is not determined by this local source inspection.
  // This compatibility hash differs from MIP-004 for newlines, quotes, and backslashes.
  return sha256(`${nonce};${JSON.stringify(result).slice(1, -1)}`);
}
export function hashMip004Result(result: string, nonce: string): string {
  validateNonce(nonce);
  if (typeof result !== 'string' || !result.isWellFormed()) throw new Error('Seller result must be valid Unicode text');
  return sha256(`${nonce};${result}`);
}

const planSchema = z.object({
  input: z.record(z.string(), z.unknown()),
  source: sourceSchema,
  network: z.literal('Preprod'),
  paymentSourceType: z.literal('Web3CardanoV2'),
  unit: z.literal(TEST_USDM_UNIT),
  amount: z.string().regex(/^[1-9]\d{0,18}$/),
  identifierFromPurchaser: z.string().regex(/^[0-9a-f]{14,26}$/),
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  payByTime: z.iso.datetime(),
  submitResultTime: z.iso.datetime(),
  unlockTime: z.iso.datetime(),
  externalDisputeUnlockTime: z.iso.datetime(),
}).strict();
export type PaymentPlan = z.infer<typeof planSchema>;

export function createPaymentPlan(input: PaymentTask, source: PaymentSource, options: { nowMs?: number; amount?: string } = {}): PaymentPlan {
  const task = taskSchema.parse(input);
  const selected = sourceSchema.parse(source);
  const now = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('Invalid payment clock');
  const nonce = sha256(JSON.stringify({ input: task, agentIdentifier: selected.agentIdentifier, network: 'Preprod' })).slice(0, 20);
  return validatePlan({ input: task, source: selected, network: 'Preprod', paymentSourceType: 'Web3CardanoV2',
    unit: TEST_USDM_UNIT, amount: options.amount ?? DEFAULT_PAYMENT_AMOUNT, identifierFromPurchaser: nonce,
    inputHash: hashPaymentInput(task, nonce), payByTime: new Date(now + 15 * MINUTE_MS).toISOString(),
    submitResultTime: new Date(now + 20 * MINUTE_MS).toISOString(), unlockTime: new Date(now + 36 * MINUTE_MS).toISOString(),
    externalDisputeUnlockTime: new Date(now + 52 * MINUTE_MS).toISOString(), });
}
export function createInputPaymentPlan(inputData: Record<string, unknown>, nonce: string, source: PaymentSource, options: { nowMs?: number; amount?: string } = {}): PaymentPlan {
  validateNonce(nonce);
  const base = createPaymentPlan({ taskId: nonce, name: 'Standard agent request', description: null }, source, options);
  return validatePlan({ ...base, input: inputData, identifierFromPurchaser: nonce, inputHash: hashCanonicalInput(inputData, nonce) });
}
export function validatePlan(value: unknown): PaymentPlan {
  const plan = planSchema.parse(value);
  if (!plan.source.agentIdentifier.startsWith(plan.source.policyId)) throw new Error('Agent policy mismatch');
  if (plan.inputHash !== hashCanonicalInput(plan.input, plan.identifierFromPurchaser)) throw new Error('Payment input hash mismatch');
  const pay = Date.parse(plan.payByTime), submit = Date.parse(plan.submitResultTime);
  const unlock = Date.parse(plan.unlockTime), dispute = Date.parse(plan.externalDisputeUnlockTime);
  if (submit - pay < 5 * MINUTE_MS || unlock - submit < 15 * MINUTE_MS || dispute - unlock < 15 * MINUTE_MS)
    throw new Error('Invalid payment deadlines');
  return plan;
}
function requireFreshPlan(plan: PaymentPlan) {
  if (Date.parse(plan.payByTime) <= Date.now() || Date.parse(plan.submitResultTime) < Date.now() + 15 * MINUTE_MS)
    throw new Error('Payment plan expired; do not replace a possibly charged plan');
}
const amountSchema = z.object({ amount: z.string().regex(/^[1-9]\d{0,18}$/), unit: z.string() });
const quoteSchema = z.object({
  id: z.string().min(1), blockchainIdentifier: z.string().min(1).max(8000),
  agentIdentifier: z.string(), pricingType: z.literal('Dynamic'), inputHash: z.string(),
  payByTime: timestamp, submitResultTime: timestamp, unlockTime: timestamp, externalDisputeUnlockTime: timestamp,
  sellerReturnAddress: z.string().nullable(), buyerReturnAddress: z.string().nullable(),
  forceLayer: z.string().nullable(), paymentForceLayer: z.string().nullable().optional(),
  RequestedFunds: z.array(amountSchema).length(1),
  SmartContractWallet: z.object({ walletVkey: hexKey, walletAddress: preprodAddress }),
  PaymentSource: z.object({ network: z.literal('Preprod'), paymentSourceType: z.literal('Web3CardanoV2'),
    policyId: hexKey, smartContractAddress: preprodAddress }),
  onChainState: z.string().nullable(), resultHash: z.string().nullable(),
  NextAction: z.object({ requestedAction: z.string(), errorType: z.string().nullable(), resultHash: z.string().nullable().optional() }),
  CurrentTransaction: z.object({ txHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(), status: z.string(),
    confirmations: z.number().int().nonnegative().nullable(), layer: z.string().optional(), hydraHeadId: z.string().nullable().optional() }).nullable(),
});
export type PaymentQuote = z.infer<typeof quoteSchema>;
export function validateQuote(planValue: PaymentPlan, value: unknown, initial = true): PaymentQuote {
  const plan = validatePlan(planValue);
  const quote = quoteSchema.parse(value);
  if (quote.agentIdentifier !== plan.source.agentIdentifier || quote.inputHash !== plan.inputHash ||
      quote.PaymentSource.policyId !== plan.source.policyId || quote.PaymentSource.smartContractAddress !== plan.source.smartContractAddress ||
      quote.SmartContractWallet.walletVkey !== plan.source.sellerVkey || quote.SmartContractWallet.walletAddress !== plan.source.sellerAddress)
    throw new Error('Unexpected payment identity or source');
  if (quote.RequestedFunds[0].unit !== TEST_USDM_UNIT || quote.RequestedFunds[0].amount !== plan.amount)
    throw new Error('Unexpected payment funds');
  for (const key of ['payByTime', 'submitResultTime', 'unlockTime', 'externalDisputeUnlockTime'] as const)
    if (quote[key] !== String(Date.parse(plan[key]))) throw new Error('Unexpected payment deadline');
  if (quote.sellerReturnAddress !== null || quote.forceLayer !== null || quote.paymentForceLayer != null)
    throw new Error('Core cannot forward signed payment overrides');
  if (quote.CurrentTransaction?.layer === 'L2' || quote.CurrentTransaction?.hydraHeadId != null)
    throw new Error('Expected an L1 payment');
  if (initial && (quote.buyerReturnAddress !== null || quote.onChainState !== null || quote.CurrentTransaction !== null ||
      (quote.resultHash !== null && quote.resultHash !== '') || quote.NextAction.requestedAction !== 'WaitingForExternalAction'))
    throw new Error('Expected a fresh unpaid quote');
  if (quote.NextAction.errorType !== null) throw new Error('MPS payment action failed');
  return quote;
}

export interface MpsClient { post(path: string, body: object, signal?: AbortSignal): Promise<unknown> }
export interface CoreClient { get(path: string, signal?: AbortSignal): Promise<unknown> }
export function createMpsClient(options: { baseUrl: string; token: string; fetch?: typeof fetch }): MpsClient {
  const base = new URL(options.baseUrl);
  if (base.username || base.password || base.search || base.hash ||
      !(base.protocol === 'https:' || (base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))))
    throw new Error('MPS URL must use HTTPS or local loopback HTTP');
  if (!options.token.trim() || /[\r\n]/.test(options.token)) throw new Error('Missing or invalid MPS token');
  base.pathname = base.pathname.replace(/\/$/, '') + '/';
  const send = options.fetch ?? fetch;
  return { async post(path, body, signal) {
    if (!['payment', 'payment/resolve-blockchain-identifier', 'payment/submit-result'].includes(path))
      throw new Error('Unsupported MPS operation');
    try {
      const response = await send(new URL(path, base), { method: 'POST', redirect: 'error',
        headers: { token: options.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]) : AbortSignal.timeout(REQUEST_MS) });
      if (!response.ok) throw new Error(`MPS HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (error instanceof Error && /^MPS HTTP \d{3}$/.test(error.message)) throw error;
      throw new Error('MPS request outcome unknown; inspect the journal before retrying');
    }
  } };
}
const envelope = z.object({ data: z.unknown() });
export async function createSignedQuote(client: MpsClient, planValue: PaymentPlan, signal?: AbortSignal): Promise<PaymentQuote> {
  const plan = validatePlan(planValue);
  requireFreshPlan(plan);
  const response = await client.post('payment', { network: plan.network, paymentSourceType: plan.paymentSourceType,
    agentIdentifier: plan.source.agentIdentifier, supportedPaymentSourceIndex: plan.source.supportedPaymentSourceIndex,
    inputHash: plan.inputHash, identifierFromPurchaser: plan.identifierFromPurchaser,
    RequestedFunds: [{ unit: plan.unit, amount: plan.amount }], payByTime: plan.payByTime,
    submitResultTime: plan.submitResultTime, unlockTime: plan.unlockTime, externalDisputeUnlockTime: plan.externalDisputeUnlockTime }, signal);
  return validateQuote(plan, envelope.parse(response).data);
}
export function buildMasumiPaymentEvent(planValue: PaymentPlan, quoteValue: PaymentQuote) {
  const plan = validatePlan(planValue), quote = validateQuote(plan, quoteValue);
  requireFreshPlan(plan);
  return { masumiPayment: { blockchainIdentifier: quote.blockchainIdentifier,
    identifierFromPurchaser: plan.identifierFromPurchaser, agentIdentifier: quote.agentIdentifier,
    sellerVkey: quote.SmartContractWallet.walletVkey, inputHash: quote.inputHash,
    payByTime: quote.payByTime, submitResultTime: quote.submitResultTime, unlockTime: quote.unlockTime,
    externalDisputeUnlockTime: quote.externalDisputeUnlockTime, Amounts: quote.RequestedFunds,
    paymentSourceType: quote.PaymentSource.paymentSourceType, supportedPaymentSourceIndex: plan.source.supportedPaymentSourceIndex,
    PaymentSource: { network: quote.PaymentSource.network, policyId: quote.PaymentSource.policyId,
      smartContractAddress: quote.PaymentSource.smartContractAddress } } };
}
export async function readPayment(client: MpsClient, plan: PaymentPlan, quote: PaymentQuote, signal?: AbortSignal) {
  const response = await client.post('payment/resolve-blockchain-identifier', { network: 'Preprod',
    blockchainIdentifier: quote.blockchainIdentifier, filterSmartContractAddress: plan.source.smartContractAddress }, signal);
  const current = validateQuote(plan, envelope.parse(response).data, false);
  if (current.id !== quote.id || current.blockchainIdentifier !== quote.blockchainIdentifier) throw new Error('MPS resolved a different payment');
  return current;
}
export async function waitForFundsLocked(client: MpsClient, planValue: PaymentPlan, quoteValue: PaymentQuote, signal?: AbortSignal): Promise<PaymentQuote> {
  const plan = validatePlan(planValue), quote = validateQuote(plan, quoteValue);
  while (Date.now() < Date.parse(plan.submitResultTime)) {
    signal?.throwIfAborted();
    const current = await readPayment(client, plan, quote, signal);
    if (Date.now() >= Date.parse(plan.submitResultTime)) throw new Error('Funds were not confirmed before the result deadline');
    if (current.onChainState === 'FundsLocked' && current.CurrentTransaction?.status === 'Confirmed' &&
        current.CurrentTransaction.txHash && (current.CurrentTransaction.confirmations ?? 0) > 0) return current;
    if (current.onChainState !== null && current.onChainState !== 'FundsLocked') throw new Error('Payment did not reach FundsLocked');
    await delay(POLL_MS, undefined, { signal });
  }
  throw new Error('Funds were not confirmed before the result deadline');
}
export async function readSellerCollection(client: MpsClient, planValue: PaymentPlan, quoteValue: PaymentQuote, signal?: AbortSignal) {
  const plan = validatePlan(planValue), quote = validateQuote(plan, quoteValue, false);
  const current = await readPayment(client, plan, quote, signal);
  const transaction = current.CurrentTransaction;
  return { payment: current, settled: current.onChainState === 'Withdrawn' && transaction?.status === 'Confirmed' &&
    !!transaction.txHash && (transaction.confirmations ?? 0) > 0,
    txHash: current.onChainState === 'Withdrawn' && transaction?.status === 'Confirmed' ? transaction.txHash : null };
}

const chainAmounts = z.array(z.object({ unit: z.string(), quantity: z.string().regex(/^\d+$/) }));
const transactionUtxos = z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/),
  inputs: z.array(z.object({ address: preprodAddress, amount: chainAmounts }).passthrough()),
  outputs: z.array(z.object({ address: preprodAddress, amount: chainAmounts }).passthrough()),
});
export function verifySellerNetReceipt(txHash: string, sellerAddress: string, value: unknown) {
  const tx = transactionUtxos.parse(value);
  preprodAddress.parse(sellerAddress);
  if (tx.hash !== txHash) throw new Error('Collection transaction mismatch');
  const total = (utxos: typeof tx.inputs) => utxos.filter(item => item.address === sellerAddress)
    .reduce((sum, item) => sum + item.amount.filter(amount => amount.unit === TEST_USDM_UNIT)
      .reduce((subtotal, amount) => subtotal + BigInt(amount.quantity), 0n), 0n);
  const received = total(tx.outputs) - total(tx.inputs);
  if (received <= 0n) throw new Error('Transaction does not prove positive seller test USDM receipt');
  return { txHash: tx.hash, sellerAddress, unit: TEST_USDM_UNIT, netAmount: received.toString() };
}
export async function submitSellerResult(client: MpsClient, planValue: PaymentPlan, quoteValue: PaymentQuote, result: string, signal?: AbortSignal, mode: 'sokosumi' | 'mip004' = 'sokosumi'): Promise<{ resultHash: string; payment: PaymentQuote }> {
  const plan = validatePlan(planValue), quote = validateQuote(plan, quoteValue, false);
  if (Date.now() >= Date.parse(plan.submitResultTime)) throw new Error('Seller result deadline expired');
  if (typeof result !== 'string' || result.length === 0) throw new Error('Missing seller result');
  if (!['sokosumi', 'mip004'].includes(mode)) throw new Error('Unknown seller result hash mode');
  const resultHash = mode === 'mip004' ? hashMip004Result(result, plan.identifierFromPurchaser) : hashPaymentResult(result, plan.identifierFromPurchaser);
  const current = await readPayment(client, plan, quote, signal);
  if (current.resultHash === resultHash || current.NextAction.resultHash === resultHash) return { resultHash, payment: current };
  if ((current.resultHash !== null && current.resultHash !== '') || current.NextAction.resultHash != null)
    throw new Error('Payment already has a different result');
  if (current.onChainState !== 'FundsLocked' || current.CurrentTransaction?.status !== 'Confirmed' ||
      !current.CurrentTransaction.txHash || (current.CurrentTransaction.confirmations ?? 0) < 1 ||
      current.NextAction.requestedAction !== 'WaitingForExternalAction') throw new Error('Seller result requires confirmed locked funds');
  if (Date.now() >= Date.parse(plan.submitResultTime)) throw new Error('Seller result deadline expired');
  const response = await client.post('payment/submit-result', { network: 'Preprod', blockchainIdentifier: quote.blockchainIdentifier,
    submitResultHash: resultHash }, signal);
  const payment = validateQuote(plan, envelope.parse(response).data, false);
  if (payment.id !== quote.id || payment.blockchainIdentifier !== quote.blockchainIdentifier ||
      (payment.resultHash !== resultHash && payment.NextAction.resultHash !== resultHash)) throw new Error('MPS did not accept the expected result hash');
  return { resultHash, payment };
}
export function submitStandardResult(client: MpsClient, plan: PaymentPlan, quote: PaymentQuote, result: string, signal?: AbortSignal) {
  return submitSellerResult(client, plan, quote, result, signal, 'mip004');
}
const receiptSchema = z.object({ blockchainIdentifier: z.string().nullable(), claimStatus: z.string().nullable(),
  onChainState: z.string().nullable(), settled: z.boolean(), txHash: z.string().nullable(),
  withdrawnForSeller: z.array(z.object({ unit: z.string().nullable(), amount: z.string().nullable() })) });
export type SellerReceipt = z.infer<typeof receiptSchema>;
export async function fetchCoreReceipt(client: CoreClient, taskId: string, signal?: AbortSignal): Promise<SellerReceipt> {
  if (!taskId) throw new Error('Missing Task ID');
  const receipt = receiptSchema.parse(envelope.parse(await client.get(`/v1/tasks/${encodeURIComponent(taskId)}/receipt`, signal)).data);
  // Core can omit the payout summary for ordinary withdrawals. The adapter still verifies the seller's chain receipt.
  const payoutSummaryRequired = receipt.onChainState === 'DisputedWithdrawn' || receipt.withdrawnForSeller.length > 0;
  if (receipt.settled && (!receipt.blockchainIdentifier || !receipt.txHash || !/^[0-9a-f]{64}$/.test(receipt.txHash) ||
      !['Withdrawn', 'DisputedWithdrawn'].includes(receipt.onChainState ?? '') ||
      (payoutSummaryRequired && !receipt.withdrawnForSeller.some(fund => fund.unit === TEST_USDM_UNIT && /^[1-9]\d*$/.test(fund.amount ?? '')))))
    throw new Error('Receipt does not prove a settled test USDM seller payout');
  return receipt;
}
