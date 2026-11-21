// Address discovery for a connected wallet (docs/decisions/0012-wallet-claims.md, "Address discovery"). A wallet
// that hands out a new address for every payment keeps its coins far from index 0, so the page walks each key path
// (receive, then change) in batches of `gapLimit` addresses and stops after `gapLimit` unused addresses in a row,
// as BIP44 wallets do, or at `maxAddressesPerScan`. Pure: deriving and looking up are passed in.
import type { WalletAddress } from './wallet-check.ts';

export type KeyPath = 'receive' | 'change';
export const KEY_PATHS: readonly KeyPath[] = ['receive', 'change'];

/** What the chain says about one address: any history or coin at all, and the satoshis of its coins without tokens. */
export interface AddressActivity {
  used: boolean;
  sats: bigint;
}

export interface FundedAddress extends WalletAddress {
  sats: bigint;
}

export interface ScanOptions {
  /** The address at `index` on `path`, or undefined when the wallet shared no key for that path. */
  derive(path: KeyPath, index: number): WalletAddress | undefined;
  /** One answer per address, in order; called once per batch. */
  lookup(addresses: readonly string[]): Promise<AddressActivity[]>;
  gapLimit: number;
  maxAddressesPerScan: number;
}

export interface ScanResult {
  /** Addresses holding coins without tokens, largest first. */
  funded: FundedAddress[];
  used: WalletAddress[];
  /** The first unused receive address. */
  receive: WalletAddress | undefined;
  /** The first unused change address; the first unused receive address when the wallet shared no change key. */
  change: WalletAddress | undefined;
  /** Addresses derived and looked up on each path. */
  scanned: Record<KeyPath, number>;
  /** True when a path reached `maxAddressesPerScan` before `gapLimit` unused addresses in a row. */
  stoppedAtCap: boolean;
}

/** Reads the activity of one address from its Electrum history and unspent coins. */
export function activityOf(history: readonly unknown[], unspent: readonly { value: number; token_data?: unknown }[]): AddressActivity {
  const sats = unspent.filter((u) => u.token_data === undefined || u.token_data === null).reduce((s, u) => s + BigInt(u.value), 0n);
  return { used: history.length > 0 || unspent.length > 0, sats };
}

interface PathScan {
  scanned: number;
  used: WalletAddress[];
  funded: FundedAddress[];
  firstUnused: WalletAddress | undefined;
  capped: boolean;
}

async function scanPath(path: KeyPath, o: ScanOptions): Promise<PathScan> {
  const out: PathScan = { scanned: 0, used: [], funded: [], firstUnused: undefined, capped: false };
  let lastUsed = -1;
  while (out.scanned - lastUsed - 1 < o.gapLimit) {
    if (out.scanned >= o.maxAddressesPerScan) {
      out.capped = true;
      break;
    }
    const want = Math.min(o.gapLimit, o.maxAddressesPerScan - out.scanned);
    const batch: WalletAddress[] = [];
    for (let i = out.scanned; i < out.scanned + want; i++) {
      const a = o.derive(path, i);
      if (!a) break;
      batch.push(a);
    }
    if (batch.length === 0) break;
    const answers = await o.lookup(batch.map((a) => a.address));
    batch.forEach((a, i) => {
      const activity = answers[i] ?? { used: false, sats: 0n };
      if (activity.used) {
        lastUsed = a.index;
        out.used.push(a);
        if (activity.sats > 0n) out.funded.push({ ...a, sats: activity.sats });
      } else {
        out.firstUnused ??= a;
      }
    });
    out.scanned += batch.length;
    // A path whose keys end before the batch does (a wallet that shares fewer keys) is done.
    if (batch.length < want) break;
  }
  return out;
}

/** Walks the receive path, then the change path, of a connected wallet. */
export async function scanWallet(o: ScanOptions): Promise<ScanResult> {
  const receive = await scanPath('receive', o);
  const change = await scanPath('change', o);
  const next = (p: PathScan, path: KeyPath) => p.firstUnused ?? (p.scanned > 0 ? o.derive(path, p.scanned) : undefined);
  const receiveNext = next(receive, 'receive');
  return {
    funded: [...receive.funded, ...change.funded].sort((a, b) => (b.sats > a.sats ? 1 : b.sats < a.sats ? -1 : 0)),
    used: [...receive.used, ...change.used],
    receive: receiveNext,
    change: change.scanned > 0 ? next(change, 'change') : receiveNext,
    scanned: { receive: receive.scanned, change: change.scanned },
    stoppedAtCap: receive.capped || change.capped,
  };
}

/** The funded addresses the relay may spend (largest first, within the limit) and the change address, without repeats. */
export function walletForRelay(found: readonly FundedAddress[], change: WalletAddress, maxAddresses: number): WalletAddress[] {
  const funded = found.filter((f) => f.address !== change.address).slice(0, Math.max(0, maxAddresses - 1));
  return [...funded, change];
}
