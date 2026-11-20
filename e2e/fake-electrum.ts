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
  rewardCategory: string;
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
  /** Chain tip; read again on every `get_tip`, so a test can move it while the page is open. */
  tip?: number;
  /** `blockchain.address.get_history` answers by address; an address not listed has no history. */
  history?: Record<string, { tx_hash: string; height: number }[]>;
  /**
   * Verbose `blockchain.transaction.get` answers by txid: a block height (confirmed), `mempool`, or `error` (the
   * server fails the request). A txid not listed is unknown to the server.
   */
  transactions?: Record<string, number | 'mempool' | 'error'>;
  /** Extra `listunspent` answers by address (a wallet's coins); read on every request, so a test can change them. */
  unspent?: Record<string, unknown[]>;
}

const UNKNOWN_TX = "daemon error: DaemonError({'code': -5, 'message': 'No such mempool or blockchain transaction.'})";

/** The server's answer to `blockchain.transaction.get` for one txid, as a result or an error message. */
function txAnswer(chain: FakeChain, tip: number, txid: string): { result: unknown } | { error: string } {
  const entry = chain.transactions?.[txid];
  if (entry === undefined) return { error: UNKNOWN_TX };
  if (entry === 'error') return { error: 'internal error' };
  if (entry === 'mempool') return { result: { txid, hex: '' } };
  return { result: { txid, hex: '', confirmations: tip - entry + 1 } };
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
      if (msg.method === 'blockchain.transaction.get') {
        const a = txAnswer(chain, tip, String(msg.params[0]));
        const body = 'error' in a ? { error: { code: 2, message: a.error } } : { result: a.result };
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body }));
        return;
      }
      const result =
        msg.method === 'server.version'
          ? ['Fake', '1.5']
          : msg.method === 'blockchain.headers.get_tip'
            ? { height: chain.tip ?? tip, hex: '' }
            : msg.method === 'blockchain.address.listunspent'
              ? (chain.unspent?.[String(msg.params[0])] ?? unspent[String(msg.params[0])] ?? [])
              : msg.method === 'blockchain.address.get_history'
                ? (chain.history?.[String(msg.params[0])] ?? [])
                : null;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
}
