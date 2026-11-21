import { describe, expect, it } from 'vitest';
import { binToHex, decodeCashAddress, encodeCashAddress, encodeTransaction, hashTransaction, hexToBin } from '@bitauth/libauth';
import { loadConfig } from '../src/config.ts';
import {
  addWalletClaim, firstChipnetAddress, leafIndexOf, parseWalletClaims, readEnvValue, redact, txSizeAndFee, validateThirdPartyWallet,
  withEnvValue,
  type WalletClaim,
} from '../src/wallet-driver.ts';

// The public BIP39 test phrase; never a real wallet's.
const NAME = 'TUAI_W3_MNEMONIC';
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ADDR = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: new Uint8Array(20).fill(0x11) }).address;
const claim = (o: Partial<WalletClaim> = {}): WalletClaim => ({
  txid: 'ab'.repeat(32), wallet: 'Cashonize v0.15.2', commit: 'c0'.repeat(20), leafIndex: 7, address: ADDR, height: null,
  at: '2026-11-20T15:00:00.000Z', ...o,
});

describe('log filter', () => {
  it('cuts a WizardConnect pairing link and keeps the rest of the line', () => {
    const line = 'link wiz://AbC123?relay=wss%3A%2F%2Fr.example&k=00ff shown; leaf 3';
    const out = redact(line, []);
    expect(out).toBe('link wiz://[hidden] shown; leaf 3');
    expect(out).not.toContain('AbC123');
  });

  it('hides the phrase, also with other spacing, line breaks or upper case', () => {
    const spaced = PHRASE.split(' ').join('  ').replace('about', '\nABOUT');
    for (const line of [`phrase=${PHRASE}.`, spaced]) {
      const out = redact(line, [PHRASE]);
      expect(out).toContain('[hidden]');
      expect(out.toLowerCase()).not.toContain('about');
    }
  });

  it('cuts other pairing schemes, hides a long secret and ignores very short secrets', () => {
    expect(redact('uri cc://x1 and abc', ['ab'])).toBe('uri cc://[hidden] and abc');
    expect(redact('token=s3cr3t-value-long', ['s3cr3t-value-long'])).toBe('token=[hidden]');
  });
});

describe('.env value', () => {
  it('is read with or without quotes and added once, never replaced', () => {
    expect(readEnvValue(`A=1\n${NAME}="x y z"\n`, NAME)).toBe('x y z');
    expect(readEnvValue(`${NAME}=\n`, NAME)).toBeUndefined();
    const text = withEnvValue(`A=1\n${NAME}=`, NAME, PHRASE);
    expect(text.split('\n')).toEqual(['A=1', `${NAME}="${PHRASE}"`, '']);
    expect(readEnvValue(text, NAME)).toBe(PHRASE);
    expect(() => withEnvValue(text, NAME, 'other words here')).toThrow(/never replaced/);
  });
});

describe('wallet claims record', () => {
  it('starts empty, adds a claim and fills its height later without a second entry', () => {
    const r = addWalletClaim(parseWalletClaims(undefined), claim());
    expect(r.claims).toHaveLength(1);
    const again = addWalletClaim(parseWalletClaims(JSON.stringify(r)), claim({ height: 337900, at: '2026-11-20T16:00:00.000Z' }));
    expect(again.claims).toEqual([claim({ height: 337900 })]);
  });

  it('fills in size and fee once read, keeps them when a later update has none, and refuses non-positive values', () => {
    const r = addWalletClaim(parseWalletClaims(undefined), claim({ height: 337900 }));
    const sized = addWalletClaim(r, claim({ height: null, bytes: 1901, feeSats: 1901 }));
    expect(sized.claims).toEqual([claim({ height: 337900, bytes: 1901, feeSats: 1901 })]);
    expect(addWalletClaim(sized, claim({ height: 337901 })).claims).toEqual([claim({ height: 337901, bytes: 1901, feeSats: 1901 })]);
    expect(parseWalletClaims(JSON.stringify(sized)).claims[0]).toMatchObject({ bytes: 1901, feeSats: 1901 });
    expect(() => addWalletClaim(r, claim({ bytes: 0, feeSats: 10 }))).toThrow(/bytes/);
    expect(() => addWalletClaim(r, claim({ bytes: 200, feeSats: 1.5 }))).toThrow(/feeSats/);
  });

  it('reads size and fee of a transaction from its raw hex and the outputs it spends', async () => {
    const out = (sats: bigint) => ({ lockingBytecode: hexToBin('76a914' + '11'.repeat(20) + '88ac'), valueSatoshis: sats });
    const prev = encodeTransaction({ version: 2, locktime: 0, inputs: [], outputs: [out(3000n), out(10000n)] });
    const prevId = hashTransaction(prev);
    const tx = encodeTransaction({
      version: 2, locktime: 0, outputs: [out(8000n)],
      inputs: [{ outpointTransactionHash: hexToBin(prevId), outpointIndex: 1, sequenceNumber: 0, unlockingBytecode: new Uint8Array(0) }],
    });
    const raw: Record<string, string> = { [prevId]: binToHex(prev), tx: binToHex(tx) };
    expect(await txSizeAndFee(async (id) => raw[id]!, 'tx')).toEqual({ bytes: tx.length, feeSats: 2000 });
    await expect(txSizeAndFee(async () => 'ff', 'bad')).rejects.toThrow(/bad/);
  });

  it('refuses entries that are not a chipnet claim', () => {
    expect(() => addWalletClaim(parseWalletClaims(undefined), claim({ txid: 'AB'.repeat(32) }))).toThrow(/txid/);
    expect(() => addWalletClaim(parseWalletClaims(undefined), claim({ address: ADDR.replace('bchtest', 'bitcoincash') }))).toThrow(/chipnet/);
    expect(() => addWalletClaim(parseWalletClaims(undefined), claim({ height: 0 }))).toThrow(/height/);
    expect(() => parseWalletClaims(JSON.stringify({ network: 'mainnet', claims: [] }))).toThrow(/chipnet/);
    expect(() => parseWalletClaims(JSON.stringify({ network: 'chipnet', claims: [claim({ at: 'today' })] }))).toThrow(/ISO/);
  });

  it('finds the leaf index of the claimed address', () => {
    expect(leafIndexOf([{ address: 'bchtest:x' }, { address: ADDR }], ADDR)).toBe(1);
    expect(() => leafIndexOf([{ address: 'bchtest:x' }], ADDR)).toThrow(/not a leaf/);
  });

  it('finds the leaf when the epoch lists the token-aware form of the address the wallet shows', () => {
    const d = decodeCashAddress(ADDR);
    if (typeof d === 'string') throw new Error(d);
    const tokenForm = encodeCashAddress({ prefix: d.prefix, type: 'p2pkhWithTokens', payload: d.payload }).address;
    expect(tokenForm.startsWith('bchtest:z')).toBe(true);
    expect(leafIndexOf([{ address: 'bchtest:x' }, {}, { address: tokenForm }], ADDR)).toBe(2);
    const other = encodeCashAddress({ prefix: d.prefix, type: 'p2pkhWithTokens', payload: d.payload.map((b, i) => (i === 0 ? b ^ 1 : b)) }).address;
    expect(() => leafIndexOf([{ address: other }], ADDR)).toThrow(/not a leaf/);
  });
});

describe('wallet screen and config', () => {
  it('reads the first chipnet P2PKH address, not a token address', () => {
    const token = ADDR.replace('bchtest:q', 'bchtest:z');
    expect(firstChipnetAddress([token, `Address: ${ADDR}`])).toBe(ADDR);
    expect(firstChipnetAddress([token])).toBeUndefined();
  });

  it('accepts the shipped settings and refuses mainnet, a reserved port or a larger fund ceiling', () => {
    const w = loadConfig().thirdPartyWallet;
    expect(validateThirdPartyWallet(w)).toEqual([]);
    expect(validateThirdPartyWallet({ ...w, network: 'mainnet' as 'chipnet' })).toHaveLength(1);
    expect(validateThirdPartyWallet({ ...w, port: 4173 })).toHaveLength(1);
    expect(validateThirdPartyWallet({ ...w, maxFundSats: 30_001 })).toHaveLength(1);
    expect(validateThirdPartyWallet(undefined)).toEqual(['thirdPartyWallet is missing']);
  });
});
