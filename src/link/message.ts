import {
  base64ToBin,
  bigIntToCompactUint,
  binToBase64,
  cashAddressToLockingBytecode,
  decodeCashAddress,
  encodeCashAddress,
  hash160,
  hash256,
  secp256k1,
  utf8ToBin,
} from '@bitauth/libauth';
import { binToHex, concat } from '../bytes.ts';

/**
 * Compatibility link message (docs/SPEC.md section 8). A user who has no address in their Folding@home name signs
 * this text with the key of the address FoldingCash maps them to, in the signed message format BCH wallets use.
 */
export interface LinkClaim {
  /** Folding@home user name, exactly as in the public daily stats file. */
  name: string;
  /** CashAddr with its prefix; P2PKH only, since a signature can only prove a key hash. */
  address: string;
  /** Base64 compact recoverable signature (65 bytes), as wallets print it. */
  signature: string;
}

/** Magic prefix of the wallet signed message format (Electron Cash and other BCH wallets use the same one). */
const MAGIC = utf8ToBin('Bitcoin Signed Message:\n');
const HEADER = 'FoldingCash compatibility link';
const MAX_NAME = 200;

/** One canonical spelling of a P2PKH CashAddr: lowercase, with prefix, without the token flag. */
export function canonicalAddress(address: string): string {
  const decoded = decodeCashAddress(address.trim().toLowerCase());
  if (typeof decoded === 'string') throw new Error(`invalid address ${address}: ${decoded}`);
  if (decoded.type !== 'p2pkh' && decoded.type !== 'p2pkhWithTokens') {
    throw new Error(`address ${address} is not P2PKH; a signed message can only prove a key hash`);
  }
  return encodeCashAddress({ prefix: decoded.prefix, type: 'p2pkh', payload: decoded.payload }).address;
}

export function linkMessage(domain: string, name: string, address: string): string {
  if (!domain || /[\r\n]/.test(domain)) throw new Error('link domain must be one non-empty line');
  if (!name || name.length > MAX_NAME || /[\r\n\t]/.test(name)) throw new Error(`Folding@home name must be 1..${MAX_NAME} characters on one line`);
  return `${HEADER}\ndomain: ${domain}\nfah: ${name}\naddress: ${canonicalAddress(address)}`;
}

/** Hash wallets sign: hash256(varint(len magic) || magic || varint(len message) || message). */
export function messageHash(message: string): Uint8Array {
  const body = utf8ToBin(message);
  return hash256(concat(bigIntToCompactUint(BigInt(MAGIC.length)), MAGIC, bigIntToCompactUint(BigInt(body.length)), body));
}

export function signLink(privateKey: Uint8Array, domain: string, name: string, address: string): LinkClaim {
  const canonical = canonicalAddress(address);
  const decoded = cashAddressToLockingBytecode(canonical);
  const ownKeyHash = binToHex(hash160(secp256k1.derivePublicKeyCompressed(privateKey) as Uint8Array));
  if (typeof decoded === 'string' || binToHex(decoded.bytecode) !== `76a914${ownKeyHash}88ac`) throw new Error(`the key does not control ${canonical}`);
  const signed = secp256k1.signMessageHashRecoverableCompact(privateKey, messageHash(linkMessage(domain, name, canonical)));
  if (typeof signed === 'string') throw new Error(`signing failed: ${signed}`);
  const header = 27 + signed.recoveryId + 4;
  return { name, address: canonical, signature: binToBase64(concat(Uint8Array.of(header), signed.signature)) };
}

export type LinkCheck = { ok: true; lockingBytecode: string } | { ok: false; reason: string };

/** Checks that `signature` over the link message was made by the key behind `address`. Never throws. */
export function verifyLink(domain: string, claim: LinkClaim): LinkCheck {
  let message: string;
  let canonical: string;
  try {
    canonical = canonicalAddress(claim.address);
    message = linkMessage(domain, claim.name, canonical);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const raw = /^[A-Za-z0-9+/]{86}[A-Za-z0-9+/=]{2}$/.test(claim.signature ?? '') ? base64ToBin(claim.signature) : undefined;
  const head = raw?.length === 65 ? raw[0] : undefined;
  if (!raw || head === undefined || head < 27 || head > 34) return { ok: false, reason: 'signature is not a 65-byte compact signature' };
  const recoveryId = ((head - 27) & 3) as 0 | 1 | 2 | 3;
  const compressed = head >= 31;
  const hash = messageHash(message);
  const sig = raw.slice(1);
  const key = compressed
    ? secp256k1.recoverPublicKeyCompressed(sig, recoveryId, hash)
    : secp256k1.recoverPublicKeyUncompressed(sig, recoveryId, hash);
  if (typeof key === 'string') return { ok: false, reason: 'no public key recovers from this signature' };
  const decoded = cashAddressToLockingBytecode(canonical);
  if (typeof decoded === 'string') return { ok: false, reason: decoded };
  const lockingBytecode = binToHex(decoded.bytecode);
  if (lockingBytecode !== `76a914${binToHex(hash160(key))}88ac`) return { ok: false, reason: 'signature was not made by the key of this address' };
  return { ok: true, lockingBytecode };
}
