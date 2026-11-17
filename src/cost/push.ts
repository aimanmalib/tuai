// Builds (never broadcasts) push distributions in the layout of the sponsor's distribution script, to measure their size.
// Layout: one P2PKH input holding the reward tokens and the BCH, output 0 = BCH change to the distributor, then one
// output per recipient carrying the dust amount and that recipient's tokens.
import { MockNetworkProvider, SignatureTemplate, TransactionBuilder, TransactionTooLargeError, randomUtxo, type Output } from 'cashscript';
import { binToHex, hash160, secp256k1, sha256 } from '@bitauth/libauth';
import { concat } from '../bytes.ts';

export interface PushModel {
  category: string;
  /** Fungible amount per recipient output, in base units. */
  amountPerRecipient: bigint;
  dustSats: bigint;
  feeRate: number;
}

const encode = (s: string) => new TextEncoder().encode(s);
const p2pkh = (h: Uint8Array) => concat(Uint8Array.of(0x76, 0xa9, 0x14), h, Uint8Array.of(0x88, 0xac));

/** A fixed model key with no funds; it only signs transactions that are measured and discarded. */
function distributor() {
  const privateKey = sha256.hash(encode('tuai push cost model distributor'));
  const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof publicKey === 'string') throw new Error(publicKey);
  const lockingBytecode = p2pkh(hash160(publicKey));
  return { signer: new SignatureTemplate(privateKey), lockingBytecode };
}

const recipient = (i: number): Uint8Array => p2pkh(sha256.hash(encode(`tuai push cost model recipient ${i}`)).slice(0, 20));

/** Signed push distribution to `recipients` outputs, as transaction hex. */
export function buildPushDistribution(recipients: number, model: PushModel): string {
  if (!Number.isSafeInteger(recipients) || recipients < 1) throw new Error('recipients must be a positive integer');
  const { signer, lockingBytecode } = distributor();
  const n = BigInt(recipients);
  const input = {
    ...randomUtxo({ satoshis: n * model.dustSats * 2n + 1_000_000n }),
    lockingBytecode: binToHex(lockingBytecode),
    token: { category: model.category, amount: n * model.amountPerRecipient },
  };
  const outputs: Output[] = [];
  for (let i = 0; i < recipients; i += 1) {
    outputs.push({ to: recipient(i), amount: model.dustSats, token: { category: model.category, amount: model.amountPerRecipient } });
  }
  const build = (change: bigint) =>
    new TransactionBuilder({ provider: new MockNetworkProvider() })
      .addInput(input, signer.unlockP2PKH())
      .addOutput({ to: lockingBytecode, amount: change })
      .addOutputs(outputs)
      .build();
  // Same two-pass fee as the sponsor script: measure with a placeholder change, then pay one rate per byte.
  const draft = build(1_000n).length / 2;
  const change = input.satoshis - n * model.dustSats - BigInt(Math.ceil(draft * model.feeRate));
  return build(change);
}

/** Serialized size in bytes of a signed push distribution to `recipients` outputs. */
export const pushDistributionBytes = (recipients: number, model: PushModel): number =>
  buildPushDistribution(recipients, model).length / 2;

export interface PushPlan {
  recipients: number;
  transactions: number;
  bytes: number;
  feeSats: number;
  dustSats: number;
}

/** Largest recipient count whose push transaction stays within `maxBytes`. */
export function maxRecipientsPerTx(maxBytes: number, model: PushModel): number {
  const fits = (n: number): boolean => {
    try {
      return pushDistributionBytes(n, model) <= maxBytes;
    } catch (e) {
      if (e instanceof TransactionTooLargeError) return false;
      throw e;
    }
  };
  const one = pushDistributionBytes(1, model);
  const perRecipient = pushDistributionBytes(2, model) - one;
  let n = Math.max(1, Math.floor((maxBytes - one) / perRecipient) + 1);
  while (n > 1 && !fits(n)) n -= 1;
  while (fits(n + 1)) n += 1;
  return n;
}

/** Splits `recipients` into standard-size push transactions and totals their measured size, fee and dust. */
export function planPush(recipients: number, maxPerTx: number, model: PushModel): PushPlan {
  const full = Math.floor(recipients / maxPerTx);
  const rest = recipients % maxPerTx;
  const bytes = full * (full > 0 ? pushDistributionBytes(maxPerTx, model) : 0) + (rest > 0 ? pushDistributionBytes(rest, model) : 0);
  return {
    recipients,
    transactions: full + (rest > 0 ? 1 : 0),
    bytes,
    feeSats: Math.ceil(bytes * model.feeRate),
    dustSats: recipients * Number(model.dustSats),
  };
}
