// Run before a demo or a judge session: are the wallets funded and the services up? Prints what to fix.
// Usage: node scripts/preflight.mjs   (reads BLOCKFROST_API_KEY_PREPROD, SELLER_ADDRESS, BUYER_ADDRESS, ORIGIN_API_URL, TRAVEL_EXPERT_URL)
import { pathToFileURL } from 'node:url';

const USDM = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';
const TASK_USDM = 3; // a plan task spends about 3 test USDM on other agents, plus the traveller's booking fee goes the other way
export const MIN = { sellerAda: 20, buyerAda: 15, buyerUsdm: TASK_USDM, buyerUsdmWarn: 4 * TASK_USDM };
const DISPENSER = 'https://dispenser.masumi.network';

const balance = (wallet, unit) => Number(wallet?.amount?.find(a => a.unit === unit)?.quantity ?? 0) / 1e6;

export function evaluateWallets({ seller, buyer }) {
  const problems = [], warnings = [];
  const s = { ada: balance(seller, 'lovelace'), usdm: balance(seller, USDM) };
  const b = { ada: balance(buyer, 'lovelace'), usdm: balance(buyer, USDM) };
  b.tasksLeft = Math.floor(b.usdm / TASK_USDM);
  if (s.ada < MIN.sellerAda) problems.push(`The seller wallet has ${s.ada.toFixed(1)} ADA (needs ${MIN.sellerAda}). Result submissions stall below 7 ADA. Top it up at ${DISPENSER} (tick the collateral box).`);
  if (b.ada < MIN.buyerAda) problems.push(`The buyer wallet has ${b.ada.toFixed(1)} ADA (needs ${MIN.buyerAda}). Top it up at ${DISPENSER}.`);
  if (b.usdm < MIN.buyerUsdm) problems.push(`The buyer wallet has ${b.usdm.toFixed(1)} test USDM, not enough for one task. Top it up at ${DISPENSER}.`);
  else if (b.usdm < MIN.buyerUsdmWarn) warnings.push(`The buyer wallet can pay for about ${b.tasksLeft} more tasks. Top it up soon at ${DISPENSER}.`);
  return { ok: problems.length === 0, problems, warnings, seller: s, buyer: b };
}

async function check(name, run) {
  try { return { name, ...(await run()) }; } catch (error) { return { name, ok: false, detail: String(error?.message ?? error).slice(0, 120) }; }
}

export async function runPreflight({ env = process.env, fetch: send = fetch } = {}) {
  const checks = [];
  const key = env.BLOCKFROST_API_KEY_PREPROD;
  const read = async address => (await send(`https://cardano-preprod.blockfrost.io/api/v0/addresses/${address}`, { headers: { project_id: key }, signal: AbortSignal.timeout(20_000) })).json();
  let wallets = { ok: false, problems: ['Wallet addresses or the Blockfrost key are not set.'], warnings: [] };
  if (key && env.SELLER_ADDRESS && env.BUYER_ADDRESS) {
    try { wallets = evaluateWallets({ seller: await read(env.SELLER_ADDRESS), buyer: await read(env.BUYER_ADDRESS) }); }
    catch (error) { wallets = { ok: false, problems: [`Could not read the wallets: ${String(error?.message ?? error).slice(0, 80)}`], warnings: [] }; }
  }
  checks.push({ name: 'wallets', ok: wallets.ok, detail: wallets.ok ? `seller ${wallets.seller.ada.toFixed(0)} ADA / ${wallets.seller.usdm.toFixed(0)} USDM, buyer ${wallets.buyer.ada.toFixed(0)} ADA / ${wallets.buyer.usdm.toFixed(0)} USDM (about ${wallets.buyer.tasksLeft} tasks)` : wallets.problems.join(' ') });
  const up = (name, url) => check(name, async () => { const r = await send(new URL('/availability', url), { signal: AbortSignal.timeout(20_000) }); const j = await r.json(); return { ok: r.ok && j.status === 'available', detail: j.status ?? `HTTP ${r.status}` }; });
  if (env.ORIGIN_API_URL) checks.push(await up('origin-api', env.ORIGIN_API_URL));
  if (env.TRAVEL_EXPERT_URL) checks.push(await up('travel-expert', env.TRAVEL_EXPERT_URL));
  return { ok: checks.every(c => c.ok), checks, warnings: wallets.warnings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runPreflight();
  for (const c of result.checks) console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.name}: ${c.detail ?? ''}`);
  for (const w of result.warnings) console.log(`WARN ${w}`);
  process.exitCode = result.ok ? 0 : 1;
}
