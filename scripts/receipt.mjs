// The receipt that closes a plan: every agent hired for this task, what it cost, and the on-chain proof.
import { resolve } from 'node:path';
import { openLedger } from './ledger.mjs';

export const EXPLORER = 'https://preprod.cexplorer.io';
export const DEFAULT_CAP_ATOMIC = '4000000';
const SERVICES = { 'hotel-search': 'Hotel search', 'flight-search': 'Flight search', knowledge: 'Knowledge desk', audit: 'Plan audit' };
const STATUS = { started: 'in progress', completed: 'delivered', failed: 'failed, no charge kept', 'refund-requested': 'refund requested', 'unpaid-fallback': 'answered without payment' };
const usdm = atomic => `${Number(BigInt(atomic ?? 0)) / 1_000_000} test USDM`;
const link = (label, tx, explorer) => tx ? `[${label}](${explorer}/tx/${tx})` : '-';

export function renderReceipt(ledger, { capAtomic = DEFAULT_CAP_ATOMIC, explorer = EXPLORER } = {}) {
  const purchases = ledger?.purchases ?? [];
  if (!purchases.length) return '';
  const rows = purchases.map(p => `| ${SERVICES[p.service] ?? p.service} | ${p.seller ?? 'Expert Travel Agency'} | ${p.status === 'unpaid-fallback' ? '0 test USDM' : usdm(p.priceAtomic)} | ${STATUS[p.status] ?? p.status} | ${link('escrow', p.escrowTx, explorer)} | ${link('result', p.resultTx, explorer)} | ${p.collectionTx ? link('collected', p.collectionTx, explorer) : p.resultTx ? 'payout pending' : '-'} |`);
  const spent = purchases.filter(p => ['started', 'completed', 'refund-requested'].includes(p.status)).reduce((sum, p) => sum + BigInt(p.priceAtomic ?? 0), 0n);
  return ['---', '**Receipt: every agent I hired for this plan (Cardano Preprod, test USDM)**', '',
    '| Service | Seller | Price | Status | Escrow | Result | Payout |', '| --- | --- | --- | --- | --- | --- | --- |', ...rows, '',
    `Spent ${usdm(spent)} of a ${usdm(capAtomic)} cap for this task. A payout is shown as collected only after its collection transaction is on-chain.`].join('\n');
}

const ledgerFor = (env = process.env) => openLedger(resolve(env.DATA_DIR || '.local', 'ledger'));
export const readLedgerEvidence = async (taskRef, env = process.env) => (await (await ledgerFor(env)).read(taskRef)).evidence;
export async function renderReceiptFor(taskRef, env = process.env) {
  return renderReceipt(await (await ledgerFor(env)).read(taskRef), { capAtomic: env.A2A_TASK_CAP_ATOMIC || DEFAULT_CAP_ATOMIC });
}
