import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createEveClient } from './eve-client.mjs';
import { repo, privateDir, readEnv } from './payment-config.mjs';
import { createStore, safeId } from './worker-state.mjs';
import { runOnce, cliRuntime, WORKER_DIRECTORY } from './worker.mjs';
import { createPaymentPlan, createMpsClient } from './payment.ts';
import { createCoreRuntime } from './core-runtime.mjs';
import { COMMENT_DIRECTORY } from './task-comments.mjs';
import { createPaidAdapter, resumeReceipt } from './paid-adapter.mjs';
import { isHosted, hostedPaidConfiguration, hostedRuntime } from './hosted.mjs';

const POLL_DELAY_MS = 10_000;
export async function loadPaidConfiguration() {
  if (isHosted()) return hostedPaidConfiguration();
  const setup = JSON.parse(await readFile(resolve(repo, 'docs/setup-state.json'), 'utf8'));
  const registration = JSON.parse(await readFile(resolve(privateDir, 'registration.json'), 'utf8'));
  if (registration.status !== 'RegistrationConfirmed' || !Number.isInteger(registration.supportedPaymentSourceIndex) ||
      registration.sellerAddress !== setup.paymentNode.sellerAddress ||
      registration.sellerVkey !== setup.paymentNode.sellerVkey || registration.policyId !== setup.paymentNode.policyId ||
      registration.smartContractAddress !== setup.paymentNode.smartContractAddress) {
    throw new Error('Confirmed Masumi registration must match the dedicated seller and Preprod V2 source.');
  }
  createPaymentPlan({ taskId: 'configuration-check', name: 'Configuration check', description: null }, registration);
  const secret = readEnv(resolve(privateDir, 'mps-runtime.env'));
  const blockfrost = readEnv(resolve(repo, '.env'));
  return {
    coworkerId: safeId(setup.coworkerId), userId: safeId(setup.account.id), source: registration,
    mps: createMpsClient({ baseUrl: setup.paymentNode.mpsBaseUrl, token: secret.MPS_TOKEN }),
    blockfrostKey: blockfrost.BLOCKFROST_API_KEY_PREPROD,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const receipt = args[0] === '--receipt';
  if (!(args.length === 0 || (args.length === 1 && ['--once', '--poll'].includes(args[0])) ||
        (receipt && args.length === 2))) throw new Error('Use --once, --poll, or --receipt TASK_ID.');
  const config = await loadPaidConfiguration();
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  const hosted = isHosted() ? hostedRuntime() : null;
  const core = await createCoreRuntime(config.coworkerId, config.userId, hosted ? { loadRuntime: hosted.loadRuntime } : undefined);
  const dependencies = {
    commentStore: await createStore(COMMENT_DIRECTORY), core,
    coworkerId: config.coworkerId, store: await createStore(WORKER_DIRECTORY), runtime: hosted ? hosted.runtime : cliRuntime(config.coworkerId),
    eve: createEveClient(),
    payments: createPaidAdapter({ ...config, core, signal: stop.signal }),
    backgroundSettlement: !!hosted,
  };
  if (receipt) {
    const release = await dependencies.store.lock(config.coworkerId);
    try { console.log(JSON.stringify(await resumeReceipt(safeId(args[1]), dependencies))); }
    finally { await release(); }
    return;
  }
  do {
    console.log(JSON.stringify(await runOnce(dependencies)));
    if (!args.includes('--poll')) break;
    await delay(POLL_DELAY_MS, undefined, { signal: stop.signal });
  } while (!stop.signal.aborted);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Paid worker stopped. Inspect the existing Task journal, registration, and runtime access before retrying.'); process.exitCode = 1; });
}
