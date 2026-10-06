# Expert Travel Agency: plan it, book it, pay per task

**TOKEN2049 Origins, Agentic Commerce track. Team Bebop (Giovanni Fu Lin, Armando Medina).**

## The problem

AI agents can search, but they cannot safely buy. Three things stop them:

- **Real money.** One retried request books a hotel twice.
- **Strangers.** An agent has no way to decide which other agent to trust with a payment.
- **No proof.** If the work is not delivered, there is no record to dispute and no refund path.

Travel makes this concrete. A traveller wants "3 days in Cebu from 20 November for 2 people" turned into hotel picks, a day plan and a checkout, without handing an agent a card.

## What we built

Three cooperating agents, hired through one Coworker.

| Agent | Role |
| --- | --- |
| **Travel Expert** (this repo) | The concierge. Talks to the traveller, runs the task, owns payment and booking steps. |
| **Expert Travel Agency** (`ExpertTravelAgency`) | Knows the place. Hotel search (`/v1/stays/search`) and a destination knowledge desk. |
| **Expert Travel Advisor** | Finds live hotel rates and opens the checkout (`/hotels/search`, `/hotels/book`). |

A task has four steps:

1. **Ask.** The traveller writes a plain-language request in Sokosumi. A missing date makes the agent ask.
2. **Plan.** Travel Expert returns hotel picks and a day plan from live rates. This is free.
3. **Book.** The traveller replies "book". The checkout is opened first, so nothing is charged for a booking that cannot happen.
4. **Pay.** A small fee (about 2% of the hotel total, 0.5 to 5 test USDM) goes into escrow. The checkout link comes back with Cardano explorer links.

## Technical approach

**Agent and tools.** Travel Expert is an [eve](https://www.npmjs.com/package/eve) agent (Node 24, TypeScript) with a deliberately small tool surface: `search_hotels` and `destination_info`. The model reasons through OpenRouter. It never touches money.

**Code decides, the model does not.** Fees, "book" or "no" replies, escrow checks and booking calls are plain code in `scripts/` (`travel-worker.mjs`, `payment.ts`, `advisor.mjs`). A paid task is never retried blindly. Its journal and payment are inspected first.

**Booking safety.** The booking layer in `ExpertTravelAgency` (Fastify, SQLite journal) requires an `Idempotency-Key`, explicit `confirm: true` and a `max_total` cap. A repeated request returns the saved result instead of booking again. Suppliers are Duffel (flights, switched off in chat) and LiteAPI (hotels), both verified against sandbox inventory.

**Cardano infrastructure.**

- **Masumi** (MIP-003 API plus the Masumi Payment Service, `mps`) handles each task's payment. The agent is registered on Cardano Preprod (`RegistrationConfirmed`, Dynamic pricing).
- **Escrow.** The fee is locked in a smart contract before the work runs (`FundsLocked`).
- **Result hash.** The agent commits to its answer with a hash submitted on-chain (`ResultSubmitted`), so the buyer can recompute and check it.
- **Payout.** After the unlock time the payment node collects the seller payout. The worker verifies the receipt on-chain and flags a task `inspectionRequired` if none arrives.
- **Blockfrost** (Preprod) reads chain state. Payments are in test USDM.
- **Sokosumi** is the marketplace. Travel Expert is a Coworker with task, comment and chat (`/v1/responses`) interfaces.

**Hosting.** One Railway project (`origin-masumi-live`) runs `travel-expert`, `origin-api` and `mps`. A volume at `/data` keeps the worker, comment and API journals across redeploys. 87 automated tests pass.

**Try it:** Coworker ID `01a112c7-de40-761e-80ae-113072c5c70f`, agent at `travel-expert-production.up.railway.app`. Task: "Plan 3 days in Cebu from 20 November for 2 people".
