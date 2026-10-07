# Trip Desk: implementation plan and cross-repo contract

Spec: `../specs/2026-10-07-trip-desk-design.md`. Decisions made after the spec, from probing (2026-10-07):

- The advisor's checkout depends on a Hotels.com persisted query and cookie, it is deployed from another account, and it fails with "no offer to open". We do not rely on it for booking.
- `origin-api` (repo `/Users/giovannifulin/Documents/ExpertTravelAgency`) already has a verified LiteAPI sandbox booking route `POST /v1/stays/bookings` (prebook + book, `Idempotency-Key`, `confirm: true`, `max_total`). LiteAPI sandbox has rated inventory for Cebu, Bangkok, Singapore, Manila (kids supported). It has none for Siargao and Bali.
- So hotel source = **LiteAPI first (bookable, real sandbox confirmation), Advisor second (pay at property, deep link)**.
- One registered Masumi seller identity offers three paid services (search, knowledge, audit) through MIP-003 `input_data` keys. The same code can run as a second identity with `SERVICES=audit` if a separate registration confirms in time.

Three work streams. Streams must not edit each other's files. Do not commit; the lead commits.

## Stream A: origin-api (`/Users/giovannifulin/Documents/ExpertTravelAgency`)

1. `staySearch` (src/schemas.ts) gains `provider: 'auto'|'liteapi'|'advisor'` (default `auto`) and `hotel_ids: string[]` (max 20, LiteAPI only; passes `hotelIds` to LiteAPI `/hotels/rates`). `auto` = LiteAPI when a key exists and it returns hotels with rooms; otherwise the Advisor if enabled; otherwise the existing behaviour. The envelope `provider` is `liteapi` or `advisor`. Existing tests are updated, none deleted without replacement.
2. `Advisor.checkout` also understands the deployed advisor shape: top-level `checkout_error` plus `stays[0].url`. It returns `{ opened:false, link_only:true, checkout_url:<stays[0].url>, failure_reason }` in that case, and keeps the old `checkout` shape working.
3. MIP-003 services in `src/masumi.ts`. `startJobSchema.input_data` accepts exactly one of:
   - `{ trip_request_json }` (existing, price `MASUMI_PRICE_ATOMIC`, default 1000000)
   - `{ knowledge_request_json }` = JSON string `{ "destination": string, "question"?: string }`, price `MASUMI_KNOWLEDGE_PRICE_ATOMIC` default 500000. Result string = `JSON.stringify(destinationKnowledge(...))` (has `answer`, `destination`, `observed_at`).
   - `{ audit_request_json }` = JSON string `AuditRequest` (below), price `MASUMI_AUDIT_PRICE_ATOMIC` default 500000. Result string = `JSON.stringify(AuditResult)`.
   Input hash for every service stays `sha256(nonce;JSON.stringify(input_data))` of the object as sent (same rule the buyer checks). `validateTerms` compares the price of the job's service. `process()` runs the right service. `SERVICES` env (comma list, default `search,knowledge,audit`) switches services on or off; `/availability` and `GET /input_schema` reflect it (extra fields are marked optional). Job records keep `service`.
4. `src/auditor.ts`: `auditPlan(config, request, model?)`.
   ```
   AuditRequest = { plan_text: string,
     constraints: { nights: number, adults: number, children_ages?: number[], budget_per_night?: number, currency?: string },
     evidence: { hotels: { name: string, total: number, nightly?: number, currency: string, free_cancellation?: boolean, source?: string }[],
                 flights?: { summary: string, total?: number, currency?: string }[],
                 knowledge?: string[] } }
   AuditResult = { verdict: 'pass'|'revise', summary: string,
     checks: { hotels_known: boolean, prices_match: boolean, budget_ok: boolean, occupancy_stated: boolean, places_grounded: boolean },
     claims: { claim: string, status: 'supported'|'unsupported'|'unverifiable', note?: string }[],
     rewrite_hints: string[], audited_at: string, method: 'rules'|'rules+model' }
   ```
   Deterministic rules first (hotel names in the plan must be in evidence, every currency figure must be evidence or a product of nights x nightly, budget cap respected, kids stated when `children_ages` present). A model pass (OpenRouter via the existing `modelFor`) checks that named places and facts are in `evidence.knowledge` or are well-known landmarks of the destination; it is optional and must degrade to rules-only without a key or on failure. Output is bounded (max 20 claims).
5. Tests for every item (node:test, no network, injected fetch/model). `npm run check && npm test && npm run build` pass.
6. Docs: README (services table, pricing), `docs/` short note. Set `FLIGHTS_ENABLED=true` on the Railway `origin-api` service. Deploy with `railway up --service origin-api --detach` from the repo (confirm the link first; do not print secrets). Verify `/availability`, `/input_schema`, `/v1/stays/search` (Cebu, `provider: liteapi`, kids) and `/v1/flights/search` live. Commit and push are done by the lead.

## Stream B: Travel Expert agent side (`/Users/giovannifulin/Documents/TravelExpert`, files under `agent/`, `scripts/a2a-buyer.mjs`, `scripts/ledger.mjs`, `scripts/receipt.mjs`, matching tests)

1. `scripts/ledger.mjs`: per-task ledger at `$DATA_DIR/ledger/<taskRef>.json` (atomic writes, file-safe id as in `worker-state.mjs`). API:
   `openLedger(dir)` -> `{ read(taskRef), recordPurchase(taskRef, entry), updatePurchase(taskRef, id, patch), addEvidence(taskRef, kind, value), spent(taskRef) }`.
   Purchase entry: `{ id, service: 'hotel-search'|'flight-search'|'knowledge'|'audit', seller, priceAtomic, status: 'started'|'completed'|'failed'|'refund-requested'|'unpaid-fallback', journalId, blockchainIdentifier?, escrowTx?, resultTx?, resultHash?, jobId?, at }`.
   Evidence: `{ hotels: [], flights: [], knowledge: [] }` (arrays appended; the shapes follow `AuditRequest.evidence`).
2. Governor: `A2A_TASK_CAP_ATOMIC` (default 4000000). `buy()` wrapper in `agent/lib/paid.ts` refuses a hop when `spent + price > cap` and records the refusal. Per-hour limit stays.
3. `agent/lib/paid.ts`: one function `buyService({ taskRef, service, inputData, amounts })` used by every paid hop (journals, ledger, cap, cache by input). `a2a-buyer.mjs` also stores the seller's `transactions` and `result_hash` from `/status` in the journal (`j.transactions`, `j.resultHash`) so the ledger can show escrow and result txs. Paid hops: `hotel-search` (1 USDM, `trip_request_json`), `flight-search` (1 USDM, `trip_request_json` with `flights`), `knowledge` (0.5 USDM, `knowledge_request_json`, env `A2A_PAID_KNOWLEDGE=1`; on failure fall back to the bearer-key call and record `unpaid-fallback`), `audit` (0.5 USDM, `audit_request_json`, used by the worker).
4. Tools (`agent/tools/`): `search_hotels` gains `children_ages`, `budget_per_night`, `task_ref` (required); it calls origin-api with `provider: 'auto'`, returns up to 8 ranked hotels `{ hotel_id, offer_id?, source: 'liteapi'|'advisor', bookable: boolean, name, stars?, rating?, total_price, nightly_price, nights, board?, free_cancellation, address?, review_highlights?, children_allowed?, checkout_url? }`. Ranking and the budget filter are a pure function in `agent/lib/rank.ts` (budget filter, free cancellation preferred, rating, then price). For the top 3 hotels the code fetches `/v1/stays/hotels/:id` (bearer key, free) for review highlights and `children_allowed`. A hotel that forbids children is dropped when children travel. New tool `search_flights` (`origin`, `destination` IATA codes, `departure_date`, optional `return_date`, adults, `children_ages`, `task_ref`; paid hop; only called when the traveller names a departure city). `destination_info` requires `question` and `task_ref`. `save_plan` stores `offer_id`, `source`, `bookable`, `children_ages`, `budget_per_night` in the plan file.
   Every tool result is also written to the ledger evidence.
5. `agent/instructions.md` rewritten: ask for departure city only when flights are wanted; state the party (adults + kids) and any assumption; never claim "quiet", "near the beach" or any amenity unless a tool returned it, otherwise write "not verified"; name only places from the knowledge desk answer or major landmarks; answer every traveller question using the knowledge desk (pass the question); drop the weather contradiction (the desk gives seasonal facts, the agent does not forecast); mention budget and how the pick compares.
6. `scripts/receipt.mjs`: `renderReceipt(ledger, { sourceExplorer })` -> Markdown block "Receipt: every agent I hired" with one row per purchase (service, seller, price, status, escrow tx link, result tx link, collection tx or "payout pending"), total spent vs cap. Pure function plus tests.
7. Tests (node:test, injected fetch) for ledger, governor, rank, paid wrapper, receipt, tools. Run only your own test files while others work (`node --test tests/<file>`); run the full `npm test` only at the end.

## Stream C: Travel Expert worker side (lead; `scripts/travel-worker.mjs`, `scripts/booking-copy.mjs`, new `scripts/origin-booking.mjs`, `scripts/audit.mjs`, `scripts/advisor.mjs`, docs)

1. Audit step in `plan()` (code, not model): after the model's answer, load the ledger evidence, call the paid `audit` hop, then on `revise` run one revision turn with the rewrite hints, then append `renderReceipt`. If the audit hop fails, say "not audited" in the receipt and continue (refund requested by the buyer on a missed deadline).
2. `scripts/origin-booking.mjs`: LiteAPI booking through origin-api. Dry run (refresh via search with `hotel_ids`, price within +10% of the plan, same cancellation terms), then `POST /v1/stays/bookings` with `Idempotency-Key` derived from task + hotel, `confirm: true`, `max_total`, guests from the task (default guest from env, or "under <name>" in the request). The journal records the stage before the supplier call. The booking result (id, confirmation code) goes into the result hash.
3. `booking()` order: escrow quote -> escrow confirmed -> book (LiteAPI) or open checkout (Advisor) -> result hash over the handover text -> payout proof. Advisor path: real checkout, else deep link handover (explicitly "no reservation yet"). Failure before escrow: status FAILED with the alternatives (F8). Failure after escrow: `inspectionRequired` as today.
4. Concurrency: `tick` schedules each task into an in-flight set (limit `WORKER_CONCURRENCY`, default 4), never starts the same task twice; the poll lock is held only while scheduling. `tick({ wait: true })` (tests) awaits them.
5. Offer text states the booking fee and what happens on "book". Handover shows the confirmation code, dates, party, total, cancellation terms.
6. Docs: README, `docs/agent-to-agent.md`, `docs/project-writeup.md` (+ txt), `docs/railway.md` env table, AGENTS.md. Deploy `railway up --service travel-expert --detach`, check `railway deployment list` and `/availability`, then a live task. Commit and push both repos.

## Environment added

travel-expert: `A2A_PAID_KNOWLEDGE=1`, `A2A_TASK_CAP_ATOMIC=4000000`, `A2A_AUDIT=1`, `WORKER_CONCURRENCY=4`, `A2A_AGENT_IDENTIFIER` unchanged (one seller identity), optional `A2A_AUDIT_AGENT_IDENTIFIER` / `A2A_AUDIT_URL` for a separate auditor identity.
origin-api: `FLIGHTS_ENABLED=true`, `SERVICES`, `MASUMI_KNOWLEDGE_PRICE_ATOMIC`, `MASUMI_AUDIT_PRICE_ATOMIC`.
