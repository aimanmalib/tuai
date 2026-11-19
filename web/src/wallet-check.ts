// Wallet claims (docs/decisions/0012-wallet-claims.md): the page's own check of a claim the relay prepared, before
// the wallet sees it. The relay is not trusted: every input must be a pool contract or one of the wallet's own
// addresses, every output must be one a claim may create, the leaf must get exactly what it may claim, and the
// wallet may lose at most the configured fee and dust. Pure: no DOM, no network.
import { binToHex, decodeTransaction, hexToBin, isHex, type Input, type Output, type TransactionCommon } from '@bitauth/libauth';
import type { Output as PlannedOutput } from 'cashscript';
import { checkClaimOutputs } from '../../src/relay/guard.ts';

/** One address the page derived from the wallet's keys; `path` and `index` tell the wallet which key signs. */
export interface WalletAddress {
  address: string;
  lockingBytecode: Uint8Array;
  path: string;
  index: number;
}

export interface SourceOutputJson {
  lockingBytecode: string;
  valueSatoshis: string;
  token?: { category: string; amount: string; nft?: { capability: string; commitment: string } };
}

/** The relay's `prepared` answer. */
export interface PreparedJson {
  tx: string;
  sourceOutputs: SourceOutputJson[];
}

export interface CheckContext {
  leaf: Uint8Array;
  pool: Uint8Array;
  vault: Uint8Array;
  rewardCategory: string;
  /** What the page itself read from the chain for this leaf. */
  claimable: bigint;
  wallet: readonly WalletAddress[];
  change: Uint8Array;
  maxSpendSats: bigint;
  userPrompt: string;
}

/** A BCH WalletConnect style sign request, as WizardConnect carries it, with the key path of each wallet input. */
export interface WalletSignRequest {
  transaction: TransactionCommon;
  sourceOutputs: (Input & Output)[];
  broadcast: true;
  userPrompt: string;
}

export interface CheckedClaim {
  request: WalletSignRequest;
  inputPaths: [number, string, number][];
  spendSats: bigint;
}

const hexOk = (h: unknown): h is string => typeof h === 'string' && h.length % 2 === 0 && isHex(h);
const intOk = (s: unknown): s is string => typeof s === 'string' && /^\d{1,20}$/.test(s);

function sourceOutput(j: SourceOutputJson): Output | string {
  if (!j || !hexOk(j.lockingBytecode) || !intOk(j.valueSatoshis)) return 'a source output is malformed';
  const out: Output = { lockingBytecode: hexToBin(j.lockingBytecode), valueSatoshis: BigInt(j.valueSatoshis) };
  if (j.token) {
    const t = j.token;
    if (!hexOk(t.category) || t.category.length !== 64 || !intOk(t.amount)) return 'a source token is malformed';
    const nft = t.nft;
    if (nft && (!hexOk(nft.commitment) || !['none', 'mutable', 'minting'].includes(nft.capability))) return 'a source NFT is malformed';
    out.token = {
      category: hexToBin(t.category),
      amount: BigInt(t.amount),
      ...(nft ? { nft: { capability: nft.capability as 'none' | 'mutable' | 'minting', commitment: hexToBin(nft.commitment) } } : {}),
    };
  }
  return out;
}

const asPlanned = (o: Output): PlannedOutput => ({
  to: o.lockingBytecode,
  amount: o.valueSatoshis,
  ...(o.token
    ? {
        token: {
          category: binToHex(o.token.category),
          amount: o.token.amount,
          ...(o.token.nft ? { nft: { capability: o.token.nft.capability, commitment: binToHex(o.token.nft.commitment) } } : {}),
        },
      }
    : {}),
});

/** Returns the request to hand to the wallet, or why the prepared claim is refused. */
export function checkPrepared(p: PreparedJson, c: CheckContext): CheckedClaim | { refused: string } {
  if (!p || !hexOk(p.tx) || !Array.isArray(p.sourceOutputs)) return { refused: 'the prepared claim is malformed' };
  const tx = decodeTransaction(hexToBin(p.tx));
  if (typeof tx === 'string') return { refused: `the prepared transaction does not decode: ${tx}` };
  if (p.sourceOutputs.length !== tx.inputs.length) return { refused: 'source outputs do not match the inputs' };
  const pool = binToHex(c.pool);
  const vault = binToHex(c.vault);
  const wallet = new Map(c.wallet.map((w) => [binToHex(w.lockingBytecode), w]));
  const change = binToHex(c.change);
  if (!wallet.has(change)) return { refused: 'the change address is not one of the wallet addresses' };

  const sources: (Input & Output)[] = [];
  const inputPaths: [number, string, number][] = [];
  let walletIn = 0n;
  for (const [i, input] of tx.inputs.entries()) {
    const src = sourceOutput(p.sourceOutputs[i] as SourceOutputJson);
    if (typeof src === 'string') return { refused: src };
    const script = binToHex(src.lockingBytecode);
    const own = wallet.get(script);
    if (own) {
      if (src.token) return { refused: `input ${i} would spend a token of the wallet` };
      if (input.unlockingBytecode.length !== 0) return { refused: `input ${i} of the wallet is already unlocked` };
      inputPaths.push([i, own.path, own.index]);
      walletIn += src.valueSatoshis;
    } else if (script !== pool && script !== vault) return { refused: `input ${i} spends a script that is neither the pool nor the wallet` };
    sources.push({ ...input, ...src });
  }
  if (inputPaths.length === 0) return { refused: 'the wallet pays no input' };

  const refused = checkClaimOutputs(tx.outputs.map(asPlanned), { leaf: c.leaf, pool: c.pool, vault: c.vault, relayer: c.change }, {
    rewardCategory: c.rewardCategory,
    payment: c.claimable,
  });
  if (refused) return { refused };
  const back = tx.outputs.filter((o) => binToHex(o.lockingBytecode) === change).reduce((s, o) => s + o.valueSatoshis, 0n);
  const spendSats = walletIn - back;
  if (spendSats > c.maxSpendSats) return { refused: `the wallet would pay ${spendSats} satoshis, more than ${c.maxSpendSats}` };
  return { request: { transaction: tx, sourceOutputs: sources, broadcast: true, userPrompt: c.userPrompt }, inputPaths, spendSats };
}
