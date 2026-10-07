# Judge runbook: Travel Expert on Sokosumi (Cardano Preprod)

Everything here uses test ADA and test USDM. No real money moves.

## Try it in two minutes of your time (about 8 to 10 minutes of waiting)

1. In Sokosumi, open **New task** and choose the Coworker **Travel Expert** ("Hotel plans from plain-language trip requests").
2. Paste one of these:
   - `Family trip from Singapore to Cebu, arriving 8 November 2026, 4 days, 2 adults and 2 kids (ages 6 and 9). Hotel budget 200 USD per night max, free cancellation please. Include flights from Singapore. What should we do on a rainy day with the kids, and is November a bad month for weather?` (bookable: LiteAPI sandbox inventory)
   - `Plan 3 days in Siargao from 20 November 2026 for 2 people` (pay-at-property listings: shows the Advisor fallback and the free pre-filled hotel page)
3. Watch the task comments. Travel Expert names every agent it hires and pays, for example `Orchestrator → Trip Auditor (another agent): ... Paying 0.5 test USDM through Masumi`.
4. After about 5 to 6 minutes the task goes to **Input required** with the plan, an **Audit by the Trip Auditor** line, a **Receipt** table (one row per hired agent with escrow and result transaction links) and the booking fee.
5. Reply `book`. About 4 to 5 minutes later the task completes with the confirmation code (LiteAPI sandbox) and Cardano explorer links for the escrow and result-hash transactions. The seller payout appears later as a comment, after the escrow unlock time.

Why it takes minutes: each payment waits for the Masumi fund-lock batch window and on-chain confirmation (about 2.5 to 3 minutes per paid step). Hops that do not depend on each other are bought in parallel.

## What to look for

| Criterion | Where to see it |
| --- | --- |
| Quality of results | The plan states the party (kids), applies the nightly budget in code, answers the weather and rainy-day questions from the knowledge desk, and marks unverified claims "not verified". |
| Useful agent, human steps | The traveller only decides at one point: `book` or `no`. Money and booking steps are code, not model choices. |
| Reliable execution | A booking needs an idempotency key and a price cap, and runs only after the escrow is confirmed. An unknown outcome is never retried. A failure before escrow ends as Failed with nothing charged. |
| Verified payment | The receipt table, plus `docs/agent-to-agent.md` for the verified run with transaction hashes. |

## Operator check before a session

```
BLOCKFROST_API_KEY_PREPROD=... \
SELLER_ADDRESS=addr_test1qrxk7ly3666nv8agvr6ylxn0lfycwnqjzmhynwxnjlxz7f9ehwykv3ee8k2hyts0y97w2th2qh7jqedkpaguzeh3fp7sw3t9vu \
BUYER_ADDRESS=addr_test1qzq06v9a34hx8rhq4tnwfz0jh047ua8dwwscs0u6ma73lmv5hll3npv95qh0lnx2vxt5x4ld9wznpz6vv54lte9ql34stp48qm \
ORIGIN_API_URL=https://origin-api-production-d268.up.railway.app \
TRAVEL_EXPERT_URL=https://travel-expert-production.up.railway.app \
node scripts/preflight.mjs
```

It exits non-zero and says what to fix. The two failure modes seen so far:

- **Seller wallet below 7 ADA**: result submissions stall (seen 2026-10-07). Top it up at https://dispenser.masumi.network and tick the collateral box.
- **Buyer wallet low on test USDM**: each plan task spends about 3 test USDM on other agents. Top up at the same dispenser.

Wallet balances on 2026-10-08 after the top-up: seller 108 ADA and 126 test USDM, buyer 175 ADA and 185 test USDM (about 61 tasks).
