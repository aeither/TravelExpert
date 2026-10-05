export const source = { agentIdentifier: 'a'.repeat(56) + '01', policyId: 'a'.repeat(56),
  smartContractAddress: 'addr_test1wqqqqqq', sellerVkey: 'b'.repeat(56), sellerAddress: 'addr_test1qqqqqqq', supportedPaymentSourceIndex: 0 };
export function quote(plan, locked = false) {
  return { id: 'payment-test', blockchainIdentifier: 'signed-terms-test', agentIdentifier: plan.source.agentIdentifier,
    pricingType: 'Dynamic', inputHash: plan.inputHash, payByTime: String(Date.parse(plan.payByTime)),
    submitResultTime: String(Date.parse(plan.submitResultTime)), unlockTime: String(Date.parse(plan.unlockTime)),
    externalDisputeUnlockTime: String(Date.parse(plan.externalDisputeUnlockTime)), sellerReturnAddress: null, buyerReturnAddress: null,
    forceLayer: null, RequestedFunds: [{ amount: plan.amount, unit: plan.unit }],
    SmartContractWallet: { walletVkey: source.sellerVkey, walletAddress: source.sellerAddress },
    PaymentSource: { network: 'Preprod', paymentSourceType: 'Web3CardanoV2', policyId: source.policyId, smartContractAddress: source.smartContractAddress },
    onChainState: locked ? 'FundsLocked' : null, resultHash: '',
    NextAction: { requestedAction: 'WaitingForExternalAction', errorType: null, resultHash: null },
    CurrentTransaction: locked ? { status: 'Confirmed', txHash: 'c'.repeat(64), confirmations: 1 } : null };
}
