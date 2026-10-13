import { indexer } from "envio";

indexer.onEvent(
  {
    contract: "ArchavaRentalV2",
    event: "AccessRented",
  },
  async ({ event, context }) => {
    const chainId = event.chainId ?? 10143;
    const contractAddress = event.srcAddress.toLowerCase();
    const txHash = event.transaction.hash.toLowerCase();
    const logIndex = event.logIndex;
    const entityId = `${chainId}:${contractAddress}:${txHash}:${logIndex}`;

    context.AccessRented.set({
      id: entityId,
      wallet: event.params.wallet.toLowerCase(),
      packageId: Number(event.params.packageId),
      includedMinutes: event.params.includedMinutes,
      expiresAt: event.params.expiresAt,
      amountPaid: event.params.amountPaid,
      transactionHash: event.transaction.hash,
      blockNumber: event.block.number,
      logIndex: event.logIndex,
      timestamp: event.block.timestamp,
    });
  }
);
