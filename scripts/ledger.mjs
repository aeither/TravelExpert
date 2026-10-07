// Per-task ledger of every agent we hired (purchases) and the evidence their answers produced.
// One JSON file per task at <dir>/<taskRef>.json. Writes are atomic and queued per task inside this process.
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, safeId } from './worker-state.mjs';

export const EVIDENCE_KINDS = ['hotels', 'flights', 'knowledge'];
const SPENT_STATES = new Set(['started', 'completed', 'refund-requested']);
const empty = taskRef => ({ taskRef, purchases: [], evidence: { hotels: [], flights: [], knowledge: [] } });

export async function openLedger(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = taskRef => join(directory, `${safeId(taskRef)}.json`);
  const queues = new Map();
  async function read(taskRef) {
    try {
      const found = JSON.parse(await readFile(file(taskRef), 'utf8'));
      return { ...empty(taskRef), ...found, evidence: { ...empty(taskRef).evidence, ...found.evidence } };
    } catch (error) { if (error.code === 'ENOENT') return empty(taskRef); throw error; }
  }
  // Read-modify-write one task at a time, so two tools finishing together never lose an entry.
  function mutate(taskRef, change) {
    safeId(taskRef);
    const run = (queues.get(taskRef) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const ledger = await read(taskRef);
      const out = change(ledger);
      await atomicWrite(file(taskRef), `${JSON.stringify(ledger, null, 2)}\n`);
      return out;
    });
    queues.set(taskRef, run);
    return run;
  }
  return {
    read,
    recordPurchase: (taskRef, entry) => mutate(taskRef, ledger => {
      if (!entry?.id || !entry.service) throw new Error('A purchase needs an id and a service.');
      const stored = { at: new Date().toISOString(), ...entry };
      ledger.purchases.push(stored);
      return stored;
    }),
    updatePurchase: (taskRef, id, patch) => mutate(taskRef, ledger => {
      const found = ledger.purchases.find(p => p.id === id);
      if (!found) throw new Error(`No purchase ${id} in the ledger.`);
      Object.assign(found, patch);
      return found;
    }),
    addEvidence: (taskRef, kind, value) => mutate(taskRef, ledger => {
      if (!EVIDENCE_KINDS.includes(kind)) throw new Error(`Unknown evidence kind ${kind}.`);
      const text = JSON.stringify(value);
      if (!ledger.evidence[kind].some(item => JSON.stringify(item) === text)) ledger.evidence[kind].push(value);
    }),
    // Atomic units (BigInt) committed to this task: running, finished and refund-pending purchases count, failures and free fallbacks do not.
    spent: async taskRef => (await read(taskRef)).purchases.filter(p => SPENT_STATES.has(p.status)).reduce((sum, p) => sum + BigInt(p.priceAtomic ?? 0), 0n),
  };
}
