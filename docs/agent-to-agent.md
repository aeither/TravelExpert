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

`search_hotels` (and `save_plan`) now hire the Expert Travel Agency through this buyer when `A2A_PAID_SEARCH=1` and `MPS_URL`, `MPS_BUYER_TOKEN`, `A2A_AGENT_IDENTIFIER` are set (Railway variables on `travel-expert`). Each search costs 1 test USDM and takes about 2.5 minutes (fund-lock batch window plus confirmations). Identical searches are cached for 15 minutes, at most `A2A_MAX_PER_HOUR` (default 12) paid searches run per hour, and a failed payment returns an error instead of falling back to the free endpoint. Without the flag the tool uses the free `/v1/stays/search`. The knowledge tool (`destination_info`) still uses the internal bearer key and is not paid yet.

## Not done yet

- The advisor at `expert-travel-advisor-eve.vercel.app` (registered identifier `67ab0c92…000001`) does not serve MIP-003 routes, so Travel Expert cannot buy from it yet. Its source is not in this account.

## Run it

```
MPS_URL=<mps>/api/v1 MPS_TOKEN=$MPS_BUYER_TOKEN \
A2A_SELLER_URL=https://origin-api-production-d268.up.railway.app \
A2A_AGENT_IDENTIFIER=<seller agent identifier> \
node scripts/a2a-demo.mjs Cebu 2026-11-20 2026-11-23
```
