/**
 * Writes examples/distro-example.json: a distribution response in the sponsor API's shape with synthetic recipients.
 * Recipient keys are derived from fixed labels, so the file is the same on every run and no real participant appears.
 * Addresses carry their network prefix; the input parser also accepts the bare form the live API returns.
 */
import { writeFileSync } from 'node:fs';
import { binToHex, ripemd160, secp256k1 } from '@bitauth/libauth';
import { concat, sha256 } from '../src/bytes.ts';
import { lockingBytecodeToAddress } from '../src/leaf.ts';

const OUT = new URL('../examples/distro-example.json', import.meta.url);
const RECIPIENTS = [
  { label: 'a', amount: 600, pointsGained: 1_500_000, workUnitsGained: 10 },
  { label: 'b', amount: 300, pointsGained: 750_000, workUnitsGained: 5 },
  { label: 'c', amount: 100, pointsGained: 250_000, workUnitsGained: 2 },
];

function exampleAddress(label: string): string {
  const key = sha256(new TextEncoder().encode(`tuai example recipient ${label}`));
  const pub = secp256k1.derivePublicKeyCompressed(key);
  if (typeof pub === 'string') throw new Error(pub);
  const bytecode = concat(Uint8Array.of(0x76, 0xa9, 0x14), ripemd160.hash(sha256(pub)), Uint8Array.of(0x88, 0xac));
  return lockingBytecodeToAddress(bytecode, 'bitcoincash');
}

const distro = RECIPIENTS.map((r) => ({
  amount: r.amount,
  cashTokensAddress: exampleAddress(r.label),
  pointsGained: r.pointsGained,
  workUnitsGained: r.workUnitsGained,
}));
const sum = (k: 'amount' | 'pointsGained' | 'workUnitsGained') => distro.reduce((t, d) => t + d[k], 0);
const response = {
  distro,
  distroCount: distro.length,
  endDateTime: '2026-11-01T00:00:00Z',
  startDateTime: '2026-10-01T00:00:00Z',
  totalDistro: sum('amount'),
  totalPoints: sum('pointsGained'),
  totalWorkUnits: sum('workUnitsGained'),
  firstErrorCode: 0,
  success: true,
};
writeFileSync(OUT, `${JSON.stringify(response, null, 1)}\n`);
console.log(`${OUT.pathname.split('/').slice(-2).join('/')} ${binToHex(sha256(new TextEncoder().encode(JSON.stringify(response, null, 1) + '\n')))}`);
