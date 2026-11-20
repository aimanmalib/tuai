import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import {
  addWalletClaim, firstChipnetAddress, leafIndexOf, parseWalletClaims, readEnvValue, redact, validateThirdPartyWallet, withEnvValue,
  type WalletClaim,
} from '../src/wallet-driver.ts';

// The public BIP39 test phrase; never a real wallet's.
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ADDR = 'bchtest:qr7fzmep8g7h7ymfxy74lgc0v950j3r2959lhtxxsl';
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
    expect(readEnvValue('A=1\nTUAI_W3_MNEMONIC="x y z"\n', 'TUAI_W3_MNEMONIC')).toBe('x y z');
    expect(readEnvValue('TUAI_W3_MNEMONIC=\n', 'TUAI_W3_MNEMONIC')).toBeUndefined();
    const text = withEnvValue('A=1\nTUAI_W3_MNEMONIC=', 'TUAI_W3_MNEMONIC', PHRASE);
    expect(text).toBe(`A=1\nTUAI_W3_MNEMONIC="${PHRASE}"\n`);
    expect(readEnvValue(text, 'TUAI_W3_MNEMONIC')).toBe(PHRASE);
    expect(() => withEnvValue(text, 'TUAI_W3_MNEMONIC', 'other words here')).toThrow(/never replaced/);
  });
});

describe('wallet claims record', () => {
  it('starts empty, adds a claim and fills its height later without a second entry', () => {
    const r = addWalletClaim(parseWalletClaims(undefined), claim());
    expect(r.claims).toHaveLength(1);
    const again = addWalletClaim(parseWalletClaims(JSON.stringify(r)), claim({ height: 337900, at: '2026-11-20T16:00:00.000Z' }));
    expect(again.claims).toEqual([claim({ height: 337900 })]);
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
