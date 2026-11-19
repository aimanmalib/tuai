/**
 * Block height of a confirmed transaction from an Electrum server, which reports confirmations rather than a
 * height. The height is tip - confirmations + 1 only when both come from the same tip, so the tip is read before
 * and after the confirmations and the reading is repeated when a block arrived in between.
 */
export interface HeightSource {
  tip(): Promise<number>;
  /** Confirmations of the transaction; 0 or undefined while it is unconfirmed. */
  confirmations(txid: string): Promise<number | undefined>;
}

export async function confirmedHeight(src: HeightSource, txid: string, attempts = 5): Promise<number | null> {
  for (let i = 0; i < attempts; i++) {
    const before = await src.tip();
    const conf = await src.confirmations(txid);
    const after = await src.tip();
    if (before !== after) continue;
    return conf ? after - conf + 1 : null;
  }
  throw new Error(`${txid}: the chain tip kept moving while reading confirmations, ${attempts} attempts`);
}

/** Height source over an Electrum provider's tip and verbose transaction query. */
export function electrumHeightSource(provider: {
  getBlockHeight(): Promise<number>;
  performRequest(name: string, ...params: unknown[]): Promise<unknown>;
}): HeightSource {
  return {
    tip: () => provider.getBlockHeight(),
    confirmations: async (txid) =>
      ((await provider.performRequest('blockchain.transaction.get', txid, true)) as { confirmations?: number }).confirmations,
  };
}
