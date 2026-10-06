#!/usr/bin/env node
// Real agent-to-agent purchase: Travel Expert (buyer) pays the Expert Travel Agency (seller) through MPS.
// Usage: MPS_URL=... MPS_TOKEN=... A2A_SELLER_URL=... A2A_AGENT_IDENTIFIER=... node scripts/a2a-demo.mjs "Cebu" 2026-11-20 2026-11-23
import { resolve } from 'node:path';
import { buyFromAgent, createBuyerMps, openA2aStore } from './a2a-buyer.mjs';

const [city = 'Cebu', checkIn = '2026-11-20', checkOut = '2026-11-23'] = process.argv.slice(2);
const need = name => process.env[name] || (() => { throw new Error(`Set ${name}.`); })();
const store = await openA2aStore(resolve(process.env.DATA_DIR || resolve(import.meta.dirname, '../.local'), 'a2a'));
const mps = createBuyerMps({ baseUrl: need('MPS_URL'), token: need('MPS_TOKEN') });
const trip = { stays: { check_in_date: checkIn, check_out_date: checkOut, rooms: [{ adults: 2 }], location: { city, country_code: process.env.A2A_COUNTRY || 'PH' } } };
const { journal, result } = await buyFromAgent({
  sellerUrl: need('A2A_SELLER_URL'), agentIdentifier: need('A2A_AGENT_IDENTIFIER'),
  inputData: { trip_request_json: JSON.stringify(trip) }, mps, store, journalId: process.env.A2A_JOURNAL_ID, log: console.log,
});
console.log(JSON.stringify({ journal: journal.taskId, stage: journal.stage, jobId: journal.jobId, blockchainIdentifier: journal.quote.blockchainIdentifier,
  fundsLockedTx: journal.fundsLockedTx ?? null, resultPreview: typeof result === 'string' ? result.slice(0, 400) : result }, null, 2));
