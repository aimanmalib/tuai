// Signed compatibility links (docs/SPEC.md section 8): the message, its wallet hash, `tuai link` and `watch --links`.
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { base64ToBin, binToBase64, decodeBase58Address, encodeCashAddress, hash160, secp256k1 } from '@bitauth/libauth';
import { binToHex, sha256 } from '../src/bytes.ts';
import { canonicalAddress, linkMessage, messageHash, signLink, verifyLink } from '../src/link/message.ts';
import { cliFixture, type CliFixture } from './helpers/cli-fixture.ts';

const DOMAIN = 'folding.cash';
const key = (label: string) => sha256(new TextEncoder().encode(`tuai link test ${label}`));
// Built through libauth so the test does not rely on canonicalAddress to make the address it then checks.
const addressOf = (k: Uint8Array) =>
  encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: hash160(secp256k1.derivePublicKeyCompressed(k) as Uint8Array) }).address;

const A = key('a');
const B = key('b');

describe('signed compatibility link message', () => {
  it('hashes like wallet signed messages (published compressed-key test vector)', () => {
    const raw = base64ToBin('H9L5yLFjti0QTHhPyFrZCT1V/MMnBtXKmoiKDZ78NDBjERki6ZTQZdSMCtkgoNmp17By9ItJr8o7ChX0XxY91nk=');
    const recoveryId = (((raw[0] as number) - 27) & 3) as 0 | 1 | 2 | 3;
    const recovered = secp256k1.recoverPublicKeyCompressed(raw.slice(1), recoveryId, messageHash('This is an example of a signed message.'));
    const legacy = decodeBase58Address('1F3sAm6ZtwLAUnj7d38pGFxtP3RVEvtsbV');
    if (typeof recovered === 'string' || typeof legacy === 'string') throw new Error('vector did not decode');
    expect(binToHex(hash160(recovered))).toBe(binToHex(legacy.payload));
  });

  it('accepts a link signed by the key of the address', () => {
    const claim = signLink(A, DOMAIN, 'alice_folder', addressOf(A));
    const r = verifyLink(DOMAIN, claim);
    expect(r.ok).toBe(true);
    expect(linkMessage(DOMAIN, 'alice_folder', addressOf(A))).toBe(`FoldingCash compatibility link\ndomain: ${DOMAIN}\nfah: alice_folder\naddress: ${addressOf(A)}`);
  });

  it('refuses the signature when the claim names another address', () => {
    const claim = signLink(A, DOMAIN, 'alice_folder', addressOf(A));
    expect(verifyLink(DOMAIN, { ...claim, address: addressOf(B) })).toMatchObject({ ok: false, reason: /not made by the key/ });
  });

  it('refuses the signature when the claim names another Folding@home user', () => {
    const claim = signLink(A, DOMAIN, 'alice_folder', addressOf(A));
    expect(verifyLink(DOMAIN, { ...claim, name: 'mallory' }).ok).toBe(false);
  });

  it('refuses a tampered signature and one made for another domain', () => {
    const claim = signLink(A, DOMAIN, 'alice_folder', addressOf(A));
    const raw = base64ToBin(claim.signature);
    raw[40] = (raw[40] as number) ^ 1;
    expect(verifyLink(DOMAIN, { ...claim, signature: binToBase64(raw) }).ok).toBe(false);
    expect(verifyLink(DOMAIN, { ...claim, signature: 'not base64' })).toMatchObject({ ok: false, reason: /65-byte/ });
    expect(verifyLink('other.example', claim).ok).toBe(false);
  });

  it('refuses to sign for an address the key does not control, and P2SH addresses', () => {
    expect(() => signLink(A, DOMAIN, 'alice_folder', addressOf(B))).toThrow(/does not control/);
    const p2sh = encodeCashAddress({ prefix: 'bchtest', type: 'p2sh', payload: new Uint8Array(20) }).address;
    expect(() => canonicalAddress(p2sh)).toThrow(/not P2PKH/);
    expect(() => linkMessage(DOMAIN, 'two\nlines', addressOf(A))).toThrow(/one line/);
  });
});

let f: CliFixture;
afterEach(() => f?.cleanup());

describe('tuai link and watch --links', () => {
  it('signs with a key file, verifies, and reports method 1 leaves as verified or unverified', async () => {
    f = cliFixture();
    const [d1, d2, d3] = ['demo-1', 'demo-2', 'demo-3'].map((r) => f.address(r));
    const keyFile = join(f.dir, 'state', 'keys', 'demo-1.json');
    const signed = await f.run('link', 'sign', '--name', 'dave_folder', '--address', d1 as string, '--key-file', keyFile, '--network', 'mock');
    expect(signed.code, signed.text).toBe(0);
    expect(signed.text).not.toMatch(/privateKey|[0-9a-f]{64}/);
    const link = { name: 'dave_folder', address: signed.json?.address as string, signature: signed.json?.signature as string };

    const one = await f.run('link', 'verify', '--name', link.name, '--address', link.address, '--signature', link.signature);
    expect(one.json).toMatchObject({ ok: true, domain: DOMAIN });
    const wrong = await f.run('link', 'verify', '--name', 'erin', '--address', link.address, '--signature', link.signature);
    expect(wrong.code).toBe(1);

    const allocations = f.file('a.json', { allocations: [
      { address: d1, amount: '1000', method: 1 },
      { address: d2, amount: '2000', method: 1 },
      { address: d3, amount: '3000', method: 0 },
    ] });
    const built = await f.run('epoch', 'build', '--source', 'fixture', '--file', allocations, '--network', 'mock');
    expect(built.code, built.text).toBe(0);
    const epoch = built.json?.out as string;

    const links = f.file('links.json', { links: [link] });
    const w = await f.run('watch', '--epoch', epoch, '--links', links);
    expect(w.code, w.text).toBe(0);
    const compat = w.json?.compat as { verified: Array<{ names: string[] }>; unverified: Array<{ address: string }>; invalid: unknown[] };
    expect(compat.verified.map((v) => v.names)).toEqual([['dave_folder']]);
    expect(compat.unverified).toHaveLength(1);
    expect(canonicalAddress(compat.unverified[0]?.address as string)).toBe(canonicalAddress(d2 as string));
    expect(compat.invalid).toEqual([]);

    const forged = f.file('forged.json', { links: [link, { ...link, address: canonicalAddress(d2 as string) }] });
    const bad = await f.run('watch', '--epoch', epoch, '--links', forged);
    expect(bad.code).toBe(1);
    expect(bad.json?.findings).toEqual([expect.stringMatching(/signed link 1 is invalid/)]);
    const perFile = await f.run('link', 'verify', '--links', forged, '--epoch', epoch);
    expect(perFile.json).toMatchObject({ ok: false, verified: [{ names: ['dave_folder'] }] });
  });
});
