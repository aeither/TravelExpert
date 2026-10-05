import { z } from 'zod';
import { TEST_USDM_UNIT, validatePlan, type PaymentPlan } from './payment.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const quantity = z.string().regex(/^\d+$/);
const row = z.object({ address: z.string(), reference: z.boolean().optional(), collateral: z.boolean().optional(),
  amount: z.array(z.object({ unit: z.string(), quantity })) });
const utxoSchema = z.object({ inputs: z.array(row), outputs: z.array(row) });

export function sellerNetUnits(value: unknown, address: string): bigint {
  const utxos = utxoSchema.parse(value);
  const sum = (entries: z.infer<typeof row>[]) => entries.filter(item => item.address === address && !item.reference && !item.collateral)
    .flatMap(item => item.amount).filter(amount => amount.unit === TEST_USDM_UNIT)
    .reduce((total, amount) => total + BigInt(amount.quantity), 0n);
  return sum(utxos.outputs) - sum(utxos.inputs);
}

export async function verifySellerPayment(txHash: string, planValue: PaymentPlan, apiKey: string, signal?: AbortSignal,
  options: { fetch?: typeof fetch; expectedNetUnits?: string } = {}) {
  const plan = validatePlan(planValue);
  if (!/^[0-9a-f]{64}$/.test(txHash) || !/^preprod[A-Za-z0-9]+$/.test(apiKey)) throw new Error('Missing Preprod chain proof parameters');
  const expected = options.expectedNetUnits ?? plan.amount;
  if (!/^[1-9]\d*$/.test(expected)) throw new Error('Expected seller amount must be positive atomic units');
  const send = options.fetch ?? fetch;
  const read = async (path: string) => {
    try {
      const response = await send(`https://cardano-preprod.blockfrost.io/api/v0${path}`, {
        redirect: 'error', headers: { project_id: apiKey },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Chain proof HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (error instanceof Error && /^Chain proof HTTP \d{3}$/.test(error.message)) throw error;
      throw new Error('Chain proof read failed; settlement is not determined');
    }
  };
  const transaction = z.object({ hash: z.literal(txHash), valid_contract: z.literal(true), block_height: z.number().int().nonnegative() })
    .parse(await read(`/txs/${txHash}`));
  const utxos = utxoSchema.parse(await read(`/txs/${txHash}/utxos`));
  const tip = z.object({ height: z.number().int().nonnegative() }).parse(await read('/blocks/latest'));
  const net = sellerNetUnits(utxos, plan.source.sellerAddress);
  if (tip.height < transaction.block_height || net !== BigInt(expected)) throw new Error('Chain outputs do not prove the expected seller payment');
  return { txHash, network: 'Preprod', confirmations: tip.height - transaction.block_height + 1,
    sellerAddress: plan.source.sellerAddress, unit: plan.unit, sellerNetUnits: net.toString(), expectedNetUnits: expected,
    validContract: true, utxos };
}
