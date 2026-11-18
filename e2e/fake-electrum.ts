// A fake Electrum server for the claim page, answering from the committed chipnet deployment files.
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { binToHex, hexToBin } from '@bitauth/libauth';
import { encodeReceipt, encodeState, END_KEY, receiptKey } from '../src/pool/encoding.ts';

export const config = JSON.parse(readFileSync('config/tuai.json', 'utf8')) as {
  networks: { chipnet: { electrum: { wssUrl: string } } };
};
export const record = JSON.parse(readFileSync('deployments/chipnet/pool.json', 'utf8')) as {
  poolCategory: string;
  contracts: { pool: string; vault: string; gate: string };
};
export interface Leaf {
  index: number;
  address: string;
  cumulative: string;
  lockingBytecode: string;
}
export const epoch = JSON.parse(readFileSync('deployments/chipnet/epoch-2.json', 'utf8')) as {
  epoch: number;
  root: string;
  inputsHash: string;
  depth: number;
  leaves: Leaf[];
};

export interface FakeChain {
  /** Root the pool state NFT holds; defaults to the epoch file's root. */
  root?: string;
  /** A pending root for the next epoch, confirmed at this height. */
  pendingHeight?: number;
  /** Claimed amounts by leaf. */
  claimed?: { leaf: Leaf; amount: bigint }[];
  tip?: number;
}

const stateHex = (root: string, e: number) =>
  binToHex(encodeState({ root: hexToBin(root), epoch: e, inputsHash: hexToBin(epoch.inputsHash) }));
const nft = (capability: string, commitment: string, height: number) => ({
  tx_hash: '00'.repeat(32),
  tx_pos: 0,
  height,
  value: 1000,
  token_data: { category: record.poolCategory, amount: '0', nft: { capability, commitment } },
});

export async function fakeElectrum(page: Page, chain: FakeChain = {}): Promise<void> {
  const tip = chain.tip ?? 400_000;
  const active = stateHex(chain.root ?? epoch.root, epoch.epoch);
  const gate =
    chain.pendingHeight === undefined
      ? nft('mutable', active, tip - 50)
      : nft('mutable', stateHex('cd'.repeat(32), epoch.epoch + 1), chain.pendingHeight);
  const receipts = (chain.claimed ?? []).map(({ leaf, amount }) =>
    nft('none', binToHex(encodeReceipt({ key: receiptKey(hexToBin(leaf.lockingBytecode)), next: END_KEY, claimed: amount })), tip - 10),
  );
  const unspent: Record<string, unknown[]> = {
    [record.contracts.pool]: [nft('minting', active, tip - 50)],
    [record.contracts.gate]: [gate],
    [record.contracts.vault]: receipts,
  };
  await page.routeWebSocket(config.networks.chipnet.electrum.wssUrl, (ws) => {
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as { id: number; method: string; params: unknown[] };
      const result =
        msg.method === 'server.version'
          ? ['Fake', '1.5']
          : msg.method === 'blockchain.headers.get_tip'
            ? { height: tip, hex: '' }
            : msg.method === 'blockchain.address.listunspent'
              ? (unspent[String(msg.params[0])] ?? [])
              : null;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
}
