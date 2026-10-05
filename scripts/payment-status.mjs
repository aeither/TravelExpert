import { readEnv, configFile, privateDir } from './payment-config.mjs';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const config = readEnv(configFile);
const baseUrl = 'http://127.0.0.1:3012/api/v1';
async function request(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options, redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { token: config.ADMIN_KEY, 'content-type': 'application/json' },
  });
  if (!response.ok) throw new Error(`Payment node request failed: ${response.status}`);
  const json = await response.json();
  if (json.status.toLowerCase() !== 'success') throw new Error('Payment node did not confirm success.');
  return json.data;
}

const sources = await request('/payment-source?take=100');
if (sources.PaymentSources.length !== 1) throw new Error('Expected exactly one source in the dedicated demo node.');
const source = sources.PaymentSources[0];
if (source.network !== 'Preprod' || source.paymentSourceType !== 'Web3CardanoV2') throw new Error('Demo source must be Preprod V2.');
const { Wallets } = await request(`/wallet/list?paymentSourceId=${source.id}&take=100`);
const sellers = Wallets.filter(wallet => wallet.type === 'Selling');
if (sellers.length !== 1) throw new Error('Expected one dedicated selling wallet.');
const seller = sellers[0];
if (process.argv.includes('--configure')) {
  for (const wallet of Wallets) {
    if (wallet.collectionAddress === '') await request('/wallet', { method: 'PATCH', body: JSON.stringify({ id: wallet.id, newCollectionAddress: null }) });
  }
  const runtimePath = resolve(privateDir, 'mps-runtime.env');
  if (!existsSync(runtimePath)) {
    const key = await request('/api-key', { method: 'POST', body: JSON.stringify({
      permission: 'ReadAndPay', usageLimited: 'false', UsageCredits: [],
      NetworkLimit: ['Preprod'], ChainIdLimit: [], walletScopeEnabled: true,
      WalletScopeHotWalletIds: [seller.id], x402WalletScopeEnabled: true, X402WalletScopeEvmWalletIds: [],
    }) });
    if (key.canAdmin || !key.canRead || !key.canPay || !key.walletScopeEnabled) throw new Error('Runtime key returned an unexpected scope.');
    writeFileSync(runtimePath, `MPS_TOKEN=${key.token}\n`, { mode: 0o600, flag: 'wx' });
    console.log('Scoped Preprod selling-wallet runtime key stored privately.');
  }
}

const balanceResponse = await fetch(`https://cardano-preprod.blockfrost.io/api/v0/addresses/${seller.walletAddress}`, {
  redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { project_id: config.BLOCKFROST_API_KEY_PREPROD },
});
let balance;
if (balanceResponse.status === 404) {
  balance = { status: 'not-yet-on-chain', httpStatus: 404, amount: null };
} else {
  if (!balanceResponse.ok) throw new Error(`Blockfrost balance request failed: ${balanceResponse.status}`);
  const data = await balanceResponse.json();
  balance = { status: 'measured', httpStatus: balanceResponse.status, amount: data.amount };
}
const status = {
  checkedAt: new Date().toISOString(), network: source.network, paymentSourceType: source.paymentSourceType,
  mpsBaseUrl: baseUrl, paymentSourceId: source.id, policyId: source.policyId,
  smartContractAddress: source.smartContractAddress, sellerWalletId: seller.id,
  sellerVkey: seller.walletVkey, sellerAddress: seller.walletAddress, balance,
};
writeFileSync(resolve(privateDir, 'payment-status.json'), `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(status, null, 2));
