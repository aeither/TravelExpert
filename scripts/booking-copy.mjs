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

export function handoverText(plan, checkout, taskId, booking) {
  const { hotel, request } = plan;
  const party = `${request.adults} adult${request.adults === 1 ? '' : 's'}${request.children_ages?.length ? ` + ${request.children_ages.length} child${request.children_ages.length === 1 ? '' : 'ren'}` : ''}`;
  const stay = `- Stay: ${request.city}, ${request.check_in}, ${nightsText(request.nights)}, ${party}`;
  const cancellation = hotel.free_cancellation ? 'free cancellation' : 'not refundable once booked';
  if (booking) {
    const lines = [pick(taskId, [`Booked. **${hotel.name}** is reserved for you.`, `All set: **${hotel.name}** is confirmed.`, `Your reservation at **${hotel.name}** is confirmed.`]), '',
      `- Confirmation code: **${booking.confirmation_code ?? booking.id}** (booking id ${booking.id}, status ${booking.status ?? 'confirmed'})`, stay,
      `- Total: ${Number(booking.total?.amount ?? hotel.total.amount).toFixed(2)} ${booking.total?.currency ?? hotel.total.currency}, ${cancellation}`, ''];
    if (plan.swappedFrom) lines.push(`_The top pick ${plan.swappedFrom} was no longer bookable, so I booked the next best hotel._`, '');
    lines.push(booking.sandbox ? 'This booking was made on the supplier **sandbox**: it is a real API reservation with a real confirmation code, but no hotel room is held.' : 'Keep the confirmation code for check-in.');
    return lines.join('\n');
  }
  if (checkout.kind === 'link') {
    return [`I could not open a checkout for **${hotel.name}**, so there is **no reservation yet**.`, '',
      `- Stay: ${request.city}, ${request.check_in}, ${nightsText(request.nights)}, ${party}`, `- Hotel total: ${Number(hotel.total.amount).toFixed(2)} ${hotel.total.currency}, ${cancellation}, pay at the property`, '',
      `**[Open the pre-filled hotel page](${checkout.url})** (dates and party are filled in; you finish the booking there). Nothing was charged.`].join('\n');
  }
  const lines = [pick(taskId, [`Done. Your checkout for **${hotel.name}** is open.`, `All set: I opened the checkout for **${hotel.name}**.`, `Your booking page for **${hotel.name}** is ready.`]), '', stay,
    `- Hotel total: ${Number(hotel.total.amount).toFixed(2)} ${hotel.total.currency}, ${cancellation}, pay at the property`, ''];
  if (plan.swappedFrom) lines.push(`_The top pick ${plan.swappedFrom} could not open a checkout, so I used the next best hotel._`, '');
  lines.push(checkout.url ? `**[Open the checkout](${checkout.url})**` : `Your checkout reference: ${checkout.trip_id}`, '', 'Nothing is reserved until you finish the checkout on the hotel page.');
  return lines.join('\n');
}

// The booking fee and what happens on "book", stated before the traveller decides.
export function offerFeeLine(plan) {
  const fee = feeFor(plan.hotel?.total);
  return `Booking fee if you reply "book": ${usdm(fee.usdm)} (about 2% of the hotel total). It is locked in escrow first, I only submit my result after your stay is ${plan.hotel?.source === 'liteapi' ? 'booked' : 'opened'}, and nothing else is charged.`;
}

// Adds blocks (receipt, fee) just before the closing question so the question stays the last line.
export function insertBeforeOffer(text, blocks) {
  const extra = blocks.filter(b => typeof b === 'string' && b.trim()).join('\n\n');
  if (!extra) return text;
  const at = text.lastIndexOf('Would you like me to');
  return at < 0 ? `${text}\n\n${extra}` : `${text.slice(0, at).trimEnd()}\n\n${extra}\n\n${text.slice(at)}`;
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
export const NOT_BOOKED = (reason, alternatives = []) => `I could not book it (${reason}), so nothing was charged and nothing was reserved.${alternatives.length ? ` Other options from the plan: ${alternatives.join(', ')}.` : ''} Create a new task for another plan or other dates.`;
export const REJECTED_AFTER_ESCROW = reason => `Your fee is locked in escrow, but the hotel rejected the booking (${reason}), so nothing was reserved and I did not submit my result. The escrow is not released to me; you can request the refund in Sokosumi once the result deadline passes.`;
export const NOT_OPENED = reason => `I could not open the checkout (${reason}), so nothing was charged. You can ask me for a new plan with other dates.`;

// A plain yes or no to the plan offer is decided by code, not by the model. Anything else is a change request.
export function answerToOffer(reply) {
  const t = String(reply).trim().toLowerCase().replace(/[.!]+$/, '');
  if (/^(no|nope|nah|no thanks|no thank you|not now|not yet|cancel|stop|that'?s all|that is all|done|all good|i'?m good)\b/.test(t)) return 'no';
  if (t.length <= 60 && /^(please |yes,? |yeah,? |ok,? |okay,? |sure,? )*(book|yes|yep|yeah|sure|ok|okay|go ahead|confirm|proceed|reserve|do it|let'?s do it|book it|book the hotel|please book( it)?)\b/.test(t) && !/\b(not|don'?t|instead|but|different|cheaper|another)\b/.test(t)) return 'yes';
  return undefined;
}
