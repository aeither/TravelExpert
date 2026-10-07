# Agent-to-agent payment

Travel Expert (buyer) pays the Expert Travel Agency (seller, `origin-api`) through the Railway `mps` node, using its own purchasing wallet. Code: `scripts/a2a-buyer.mjs`, demo: `scripts/a2a-demo.mjs`. The model never sees or decides any payment step.

## Flow (MIP-003 buyer side)

1. `GET /availability` on the seller.
2. `POST /start_job` with a fresh purchaser nonce. The seller answers with signed payment terms.
3. Checks before paying: expected agent identifier, nonce echoed, deadlines consistent, amount at or below the cap (default 1 test USDM), and the seller's `input_hash` equals `sha256(nonce;input)` for our exact request.
4. `POST /purchase` on our MPS with the seller's terms unchanged.
5. Wait for `FundsLocked`, then poll the seller's `/status` until `completed`.
6. If the seller misses the result deadline or fails, `POST /purchase/request-refund`.

Every external write is journaled first (`$DATA_DIR/a2a/<id>.json`). A restart looks the purchase up by `blockchainIdentifier` before it could send it again, and an unknown outcome sets `inspectionRequired` instead of retrying.

## Setup facts

- Buyer wallet `addr_test1qzq06v9a34hx8rhq4tnwfz0jh047ua8dwwscs0u6ma73lmv5hll3npv95qh0lnx2vxt5x4ld9wznpz6vv54lte9ql34stp48qm`, MPS hot wallet id `cmux8ouck008q20o79h8anc6f`, funded with 105 test ADA and 100 test USDM from the Masumi dispenser.
- MPS keys are wallet-scoped. The key shared with the seller side is scoped to the seeded wallet, which is empty, so the first attempts failed with "No wallets with funds". A dedicated `ReadAndPay` key scoped to the buyer wallet fixed it. It is stored as the Railway variable `MPS_BUYER_TOKEN` (never in git).
- A new purchase is not visible to a wallet-scoped key until MPS's lock cycle assigns it a wallet, so a 404 right after `POST /purchase` means pending, not failed.
- Seller deadlines arrive in milliseconds from `origin-api`. The buyer accepts seconds or milliseconds.

## Verified run, 2026-10-07 (Cardano Preprod)

- Journal `a2a_2add011de709`, seller job `6ed0ff53-5a8d-4ef7-a90a-6eb047197605`, request: hotels in Cebu, 2026-11-20 to 2026-11-23, 2 adults.
- Price 1 test USDM. Buyer wallet went from 100 to 99 USDM.
- Funds locked in escrow, tx `80aa44bc5faf3dec61b52a1535f146e484c55287a4a02192830b8e90bce10aec`.
- Seller submitted the result, tx `7c6ff02361ce36492fe51601e9722820b06b505bef934cf56f7232ff096ac024`, result hash `cfd837b335af42f3ecc5cf95d654e4bdf5c8ae50298154a76efed13765de6dd9`. MPS state: `ResultSubmitted`.
- The result was real hotel data (5 hotels, cheapest Papabo Backpackers Mactan, USD 54.00).
- **Seller collection is pending.** The seller can withdraw only after the unlock time. Until a `Withdrawn` state and collection transaction are checked on-chain, this is reported as pending, not as received.
- Two earlier attempts (`a2a_5362…`, `a2a_90e9…`) never created a visible purchase and moved no funds (wallet balance unchanged). Their journals are marked abandoned.

## Paid hotel search (live from 2026-10-07)

`search_hotels` (and `save_plan`) now hire the Expert Travel Agency through this buyer when `A2A_PAID_SEARCH=1` and `MPS_URL`, `MPS_BUYER_TOKEN`, `A2A_AGENT_IDENTIFIER` are set (Railway variables on `travel-expert`). Each search costs 1 test USDM and takes about 2.5 minutes (fund-lock batch window plus confirmations). Identical searches are cached for 15 minutes, at most `A2A_MAX_PER_HOUR` (default 12) paid searches run per hour, and a failed payment returns an error instead of falling back to the free endpoint. Without the flag the tool uses the free `/v1/stays/search`. 
## Trip Desk (2026-10-07)

All hops now go through `buyService` (`agent/lib/paid.ts`): hotel search and flights 1 test USDM, knowledge desk 0.5 (`A2A_PAID_KNOWLEDGE=1`, bearer-key fallback recorded as `unpaid-fallback`), Trip Auditor 0.5 (`A2A_AUDIT=1`). They are MIP-003 services of the same seller identity (`trip_request_json`, `knowledge_request_json`, `audit_request_json`). A per-task cap (`A2A_TASK_CAP_ATOMIC`, default 4 test USDM) and a ledger (`$DATA_DIR/ledger`) feed the receipt in the answer. Verified live run, 2026-10-07, Sokosumi task `01a116f0-bec4-75ad-9124-e22820235cba` (Singapore to Cebu, 2 adults + 2 children, 200 USD per night cap):

- Knowledge desk, hotel search and flight search ran in parallel (0.5 + 1 + 1 test USDM). Result: 7 hotels, 5 flight offers.
- Trip Auditor (0.5 test USDM, audit job `a67b68d6-a276-40b7-820d-48b0a6e640dd`): `pass`, 18 claims supported. Escrow tx `11572551b797b9f86b12a509b041bd6f02d79daf761787325b306de650976065`, result tx `c3de323c7873a0003e7b5ac3c640532a723b1a241b63ffe60120a9713cd2eb32`.
- The plan came back with the audit line and a receipt table (4 hops, 3 of 4 test USDM spent, payouts shown as pending).
- Reply "book": dry-run re-check, fee of 2 test USDM in escrow (tx `5e73e64c5e80c16f0beb5c354724bd7a8f53acb0ec4eea6a95baa1e3cf96e2ef`), LiteAPI sandbox booking `yt9EHruBy` CONFIRMED (code `test`), result hash tx `e55d375383ae3beab93086a3174a5ce102611b08e2e7b7b87304006142b571a9`, task Completed.
- Seller payouts are still pending: the seller can collect only after the unlock time. They are reported as pending, not received.

Second verified run, 2026-10-08, Siargao (no LiteAPI stock), task `01a1171e-923c-754e-b75c-6c042e69cd4d`: three paid hops (knowledge, hotel search, audit) with a receipt, then `book` returned the pre-filled Hotels.com page in seconds with no charge and an explicit "no reservation yet".

Issues found and fixed during the run:

- The `mps` seller wallet ran out of test ADA (5.6 ADA, 7 needed for collateral prep). Result submissions stalled for about 12 minutes until the wallet was topped up from https://dispenser.masumi.network. Keep the seller wallet funded (`addr_test1qrxk7ly3666nv8agvr6ylxn0lfycwnqjzmhynwxnjlxz7f9ehwykv3ee8k2hyts0y97w2th2qh7jqedkpaguzeh3fp7sw3t9vu`) before a demo.
- LiteAPI rejects several guests sharing one room (HTTP 400). The booker now sends one lead guest per room, and an `UPSTREAM_REJECTED` with state `failed` counts as a definite rejection.

## Not done yet

- The advisor at `expert-travel-advisor-eve.vercel.app` (registered identifier `67ab0c92…000001`) does not serve MIP-003 routes, so Travel Expert cannot buy from it yet. Its source is not in this account.

## Run it

```
MPS_URL=<mps>/api/v1 MPS_TOKEN=$MPS_BUYER_TOKEN \
A2A_SELLER_URL=https://origin-api-production-d268.up.railway.app \
A2A_AGENT_IDENTIFIER=<seller agent identifier> \
node scripts/a2a-demo.mjs Cebu 2026-11-20 2026-11-23
```
