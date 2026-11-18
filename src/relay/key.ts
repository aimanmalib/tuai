// The relayer's own chipnet key: made once by `tuai relay-key`, stored 0600, read by the relay process from a file
// mounted read-only. Only the address is ever printed or logged.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SignatureTemplate } from 'cashscript';
import { encodeCashAddress, hash160, hexToBin, secp256k1, binToHex } from '@bitauth/libauth';
import { RELAY_NETWORK } from './config.ts';
import type { RelayKey } from './service.ts';

interface KeyFile {
  role: string;
  network: string;
  privateKey: string;
}

function keyFromPrivate(privateKey: Uint8Array): RelayKey {
  const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof publicKey === 'string') throw new Error('the relay key file holds an invalid key');
  const pkh = hash160(publicKey);
  const lockingBytecode = Uint8Array.from([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);
  const address = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: pkh });
  if (typeof address === 'string') throw new Error(address);
  return { signer: new SignatureTemplate(privateKey), lockingBytecode, address: address.address };
}

/** Reads a relay key file; refuses a key made for any network other than chipnet. */
export function loadRelayKey(path: string): RelayKey {
  if (!existsSync(path)) throw new Error('the relay key file does not exist');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<KeyFile>;
  if (raw.network !== RELAY_NETWORK) throw new Error(`the relay key file is not a ${RELAY_NETWORK} key`);
  if (!raw.privateKey || !/^[0-9a-f]{64}$/.test(raw.privateKey)) throw new Error('the relay key file has no usable key');
  return keyFromPrivate(hexToBin(raw.privateKey));
}

/** Writes a new relay key (never overwrites) with mode 0600 and returns its address. */
export function createRelayKey(path: string, role: string): { address: string; path: string } {
  if (existsSync(path)) throw new Error('a relay key already exists at that path; it is never overwritten');
  let privateKey: Uint8Array;
  do privateKey = Uint8Array.from(randomBytes(32));
  while (!secp256k1.validatePrivateKey(privateKey));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const file: KeyFile = { role, network: RELAY_NETWORK, privateKey: binToHex(privateKey) };
  writeFileSync(path, `${JSON.stringify(file, null, 1)}\n`, { mode: 0o600, flag: 'wx' });
  if ((statSync(path).mode & 0o077) !== 0) throw new Error('the relay key file is readable by others');
  return { address: keyFromPrivate(privateKey).address, path };
}
