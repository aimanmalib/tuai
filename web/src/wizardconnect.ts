// WizardConnect adapter (docs/decisions/0012-wallet-claims.md), loaded only when the user starts a wallet claim.
// The library (LGPL-3.0, unmodified, from npm) carries the session over encrypted Nostr messages; this file only
// derives the wallet's addresses from the keys it shares and passes one checked sign request through.
import { hash160, lockingBytecodeToCashAddress, type CashAddressNetworkPrefix } from '@bitauth/libauth';
import { initiateDappRelay } from '@wizardconnect/core';
import { DappConnectionManager } from '@wizardconnect/dapp';
import { wireSignRequest, type WalletAddress, type WalletSignRequest } from './wallet-check.ts';
import type { KeyPath } from './wallet-scan.ts';

export interface WalletSession {
  /** The address at `index` on a key path, or undefined when the wallet shared no key for that path. */
  address(path: KeyPath, index: number, prefix: string): WalletAddress | undefined;
  /** Hex of the transaction the wallet signed (and, with broadcast, sent). */
  sign(request: WalletSignRequest, inputPaths: [number, string, number][], signal: AbortSignal): Promise<string>;
  name: string;
  close(): void;
  /** Called once when the wallet ends the session. */
  onClose(listener: () => void): void;
}

/** WizardConnect child numbers of the key paths the page uses. */
const CHILD: Record<KeyPath, number> = { receive: 0, change: 1 };

function p2pkh(publicKey: Uint8Array, prefix: string): { address: string; lockingBytecode: Uint8Array } {
  const lockingBytecode = Uint8Array.from([0x76, 0xa9, 0x14, ...hash160(publicKey), 0x88, 0xac]);
  const a = lockingBytecodeToCashAddress({ bytecode: lockingBytecode, prefix: prefix as CashAddressNetworkPrefix });
  if (typeof a === 'string') throw new Error(a);
  return { address: a.address, lockingBytecode };
}

/** Starts a session: `onUri` receives the link to show as a QR code; resolves once the wallet answered. */
export function connectWallet(o: { dappName: string; relayUrls: string[]; onUri: (uri: string, qrUri: string) => void; signal: AbortSignal }): Promise<WalletSession> {
  const mgr = new DappConnectionManager(o.dappName, undefined, { session: false });
  const relay = initiateDappRelay((payload) => mgr.updateConnection(payload.client, payload.status), o.relayUrls.length ? { explicitRelayUrls: o.relayUrls } : {});
  mgr.attachRelay(relay);
  const close = () => {
    void mgr.destroy().finally(() => relay.cleanup());
  };
  o.onUri(relay.uri, relay.qrUri);
  return new Promise((resolve, reject) => {
    o.signal.addEventListener('abort', () => {
      close();
      reject(new Error('cancelled'));
    });
    mgr.on('disconnect', (_reason, message) => reject(new Error(message ?? 'the wallet disconnected')));
    mgr.on('walletready', () =>
      resolve({
        name: mgr.walletName ?? '',
        close,
        onClose: (listener) => mgr.on('disconnect', () => listener()),
        address(path, index, prefix) {
          // Derived in the browser from the extended public key the wallet shared, so any index is available.
          const key = mgr.getPubkey(CHILD[path], BigInt(index));
          return key ? { ...p2pkh(key, prefix), path, index } : undefined;
        },
        async sign(request, inputPaths, signal) {
          const r = await mgr.signTransaction({ transaction: wireSignRequest(request) as typeof request, inputPaths }, { signal });
          if (r.error) throw new Error(r.error);
          return r.signedTransaction;
        },
      }),
    );
  });
}
