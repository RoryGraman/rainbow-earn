// Decodes the deposit transaction, so the review shows what it really does.
export const SELF_BATCH_DEPOSIT_ABI = [
  {
    name: 'selfBatchDeposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'vaults', type: 'address[]' },
      { name: 'amounts', type: 'uint256[]' },
      {
        name: 'burns',
        type: 'tuple[]',
        components: [
          { name: 'destDomain', type: 'uint32' },
          { name: 'mintRecipient', type: 'bytes32' },
          { name: 'destinationCaller', type: 'bytes32' },
          { name: 'amount', type: 'uint256' },
          { name: 'maxFee', type: 'uint256' },
          { name: 'minFinalityThreshold', type: 'uint32' },
        ],
      },
    ],
    outputs: [],
  },
] as const;
