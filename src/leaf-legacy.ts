// Legacy BTC leaves (link method 2, docs/SPEC.md "Legacy BTC leaves (method 2)"). Many Folding@home users still put an
// old Bitcoin P2PKH address ("1...") in their name. Its locking script, OP_DUP OP_HASH160 <hash160> OP_EQUALVERIFY
// OP_CHECKSIG, is byte for byte the same on BCH, so the leaf pays the key that controls that address without any
// mapping database. Only version 0x00 (P2PKH) is accepted: a P2SH or bech32 address does not carry over safely.
import {
  Base58AddressFormatVersion, binToHex, decodeBase58Address, encodeBase58Address, hexToBin,
} from '@bitauth/libauth';

/** Why a legacy address was refused. The text is stable so reports and tests can match it. */
export type LegacyBtcReason = 'bech32' | 'p2sh' | 'checksum' | 'version' | 'format';

export class LegacyBtcAddressError extends Error {
  constructor(readonly address: string, readonly reason: LegacyBtcReason) {
    super(`not a legacy BTC P2PKH address (${reason}): ${address}`);
    this.name = 'LegacyBtcAddressError';
  }
}

const P2PKH = /^76a914([0-9a-f]{40})88ac$/;

/** `1...` address to its P2PKH locking bytecode in hex. Throws `LegacyBtcAddressError` for anything else. */
export function legacyBtcToLockingBytecode(address: string): string {
  const a = address.trim();
  if (/^(bc|tb)1/i.test(a)) throw new LegacyBtcAddressError(a, 'bech32');
  if (!/^[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(a)) throw new LegacyBtcAddressError(a, 'format');
  const decoded = decodeBase58Address(a);
  if (typeof decoded === 'string') {
    throw new LegacyBtcAddressError(a, /checksum/i.test(decoded) ? 'checksum' : 'format');
  }
  if (decoded.version === Base58AddressFormatVersion.p2sh20) throw new LegacyBtcAddressError(a, 'p2sh');
  if (decoded.version !== Base58AddressFormatVersion.p2pkh) throw new LegacyBtcAddressError(a, 'version');
  return `76a914${binToHex(decoded.payload)}88ac`;
}

/** P2PKH locking bytecode (hex) back to its `1...` address, or undefined when the script is not P2PKH. */
export function lockingBytecodeToLegacyBtc(lockingBytecode: string): string | undefined {
  const m = P2PKH.exec(lockingBytecode.toLowerCase());
  return m?.[1] ? encodeBase58Address('p2pkh', hexToBin(m[1])) : undefined;
}

