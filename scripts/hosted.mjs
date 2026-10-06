import { createMpsClient } from './payment.ts';
import { safeId } from './worker-state.mjs';
import { createHttpClient, httpRuntime } from './sokosumi-http.mjs';

const required = (env, name) => {
  const value = env[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is not set.`);
  return value.trim();
};

// Hosted mode (Railway): every setting comes from the environment, nothing from local files or the Sokosumi CLI.
export const isHosted = (env = process.env) => !!env.MASUMI_AGENT_IDENTIFIER;

export function hostedPaidConfiguration(env = process.env) {
  const agentIdentifier = required(env, 'MASUMI_AGENT_IDENTIFIER');
  const source = {
    agentIdentifier, policyId: agentIdentifier.slice(0, 56),
    smartContractAddress: required(env, 'MASUMI_SMART_CONTRACT_ADDRESS'),
    sellerVkey: required(env, 'MASUMI_SELLER_VKEY'), sellerAddress: required(env, 'MASUMI_SELLER_ADDRESS'),
    supportedPaymentSourceIndex: Number(env.MASUMI_SOURCE_INDEX ?? 0),
  };
  return {
    coworkerId: safeId(required(env, 'SOKOSUMI_COWORKER_ID')), userId: undefined, source,
    mps: createMpsClient({ baseUrl: required(env, 'MPS_URL'), token: required(env, 'MPS_TOKEN') }),
    blockfrostKey: required(env, 'BLOCKFROST_API_KEY_PREPROD'),
  };
}

// Plugs the Coworker runtime key into the shared core-runtime and worker code instead of the CLI vault.
export function hostedRuntime(env = process.env) {
  const coworkerId = safeId(required(env, 'SOKOSUMI_COWORKER_ID'));
  const apiKey = required(env, 'SOKOSUMI_COWORKER_API_KEY');
  const client = createHttpClient(apiKey);
  return { coworkerId, runtime: httpRuntime(coworkerId, client), loadRuntime: async () => ({ createCoworkerHttpClient: () => client, readRuntimeCredential: () => apiKey }) };
}
