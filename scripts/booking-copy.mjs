import { createHash } from 'node:crypto';

export const EXPLORER = 'https://preprod.cexplorer.io';
export const txUrl = hash => `${EXPLORER}/tx/${hash}`;
const pick = (seed, options) => options[createHash('sha256').update(String(seed)).digest()[0] % options.length];

// The booking fee follows the trip: about 2% of the hotel total, between 0.5 and 5 test USDM, in steps of 0.1.
export function feeFor(total) {
  const amount = Number(total?.amount);
  const usdm = Number.isFinite(amount) && amount > 0 ? Math.min(5, Math.max(0.5, Math.round(amount * 0.02 * 10) / 10)) : 1;
  return { usdm, atomic: String(Math.round(usdm * 10) * 100_000) };
}
export const usdm = value => `${Number(value)} test USDM`;

const nightsText = n => `${n} night${n === 1 ? '' : 's'}`;
// Starts with the fixed phrase Sokosumi users know, then says what the money is for in a way that fits this trip.
export function paymentComment(plan, fee, taskId) {
  const { hotel, request } = plan, trip = `${hotel.name} in ${request.city} (${nightsText(request.nights)})`;
  return `Payment requested: ${usdm(fee.usdm)}. ` + pick(taskId, [
    `That is the booking fee for ${trip}. It stays in escrow until your checkout is ready.`,
    `Fee for opening the checkout at ${trip}, about 2% of the hotel total. It is locked in escrow first.`,
    `I will hold ${usdm(fee.usdm)} in escrow while I hand over the checkout for ${trip}.`,
    `Booking fee for ${trip}. You can follow it on-chain once it is locked.`,
  ]);
}

export function handoverText(plan, checkout, taskId) {
  const { hotel, request } = plan;
  const lines = [pick(taskId, [`Done. Your checkout for **${hotel.name}** is open.`, `All set: I opened the checkout for **${hotel.name}**.`, `Your booking page for **${hotel.name}** is ready.`]), '',
    `- Stay: ${request.city}, ${request.check_in}, ${nightsText(request.nights)}, ${request.adults} traveller${request.adults === 1 ? '' : 's'}`,
    `- Hotel total: ${Number(hotel.total.amount).toFixed(2)} ${hotel.total.currency}, ${hotel.free_cancellation ? 'free cancellation' : 'not refundable once booked'}, pay at the property`, ''];
  if (plan.swappedFrom) lines.push(`_The top pick ${plan.swappedFrom} could not open a checkout, so I used the next best hotel._`, '');
  lines.push(checkout.url ? `**[Open the checkout](${checkout.url})**` : `Your checkout reference: ${checkout.trip_id}`, '', 'Nothing is reserved until you finish the checkout on the hotel page.');
  return lines.join('\n');
}

export function proofBlock(paid, source, fee) {
  const link = (label, tx) => tx ? `- ${label}: ${txUrl(tx)}` : undefined;
  return ['', '---', `Payment proof (Cardano Preprod, real transactions, ${usdm(fee.usdm)}):`,
    link('1. Your payment locked in escrow', paid.escrowTx), link('2. My result hash submitted on-chain', paid.resultTx),
    '3. Seller payout: posted here as a comment once the escrow unlocks and is collected.',
    `- Escrow contract: ${EXPLORER}/address/${source.smartContractAddress}`, `- Agent registration (policy): ${EXPLORER}/policy/${source.policyId}`].filter(Boolean).join('\n');
}

export const collectionComment = (paid, fee) => ['Payout collected on-chain. The seller received the escrowed test USDM:',
  `- Seller payout transaction: ${txUrl(paid.withdrawalTx)}`, `Open the link and look for ${usdm(fee.usdm)} minus the protocol fee arriving at the seller address.`].join('\n');

export const CLOSING = 'No problem. Your plan stays here as a reference: create a new task whenever you want another one. Happy travels!';
export const NOT_OPENED = reason => `I could not open the checkout (${reason}), so nothing was charged. You can ask me for a new plan with other dates.`;

// A plain yes or no to the plan offer is decided by code, not by the model. Anything else is a change request.
export function answerToOffer(reply) {
  const t = String(reply).trim().toLowerCase().replace(/[.!]+$/, '');
  if (/^(no|nope|nah|no thanks|no thank you|not now|not yet|cancel|stop|that'?s all|that is all|done|all good|i'?m good)\b/.test(t)) return 'no';
  if (t.length <= 60 && /^(please |yes,? |yeah,? |ok,? |okay,? |sure,? )*(book|yes|yep|yeah|sure|ok|okay|go ahead|confirm|proceed|reserve|do it|let'?s do it|book it|book the hotel|please book( it)?)\b/.test(t) && !/\b(not|don'?t|instead|but|different|cheaper|another)\b/.test(t)) return 'yes';
  return undefined;
}
