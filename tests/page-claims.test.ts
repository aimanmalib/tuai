import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { hexToBin } from '../src/bytes.ts';
import { checkPageClaim, renderPageClaims, type ClaimOutput } from '../src/demo/page-claims.ts';

const p2pkh = (b: number) => hexToBin(`76a914${b.toString(16).padStart(2, '0').repeat(20)}88ac`);
const POOL = hexToBin(`aa20${'11'.repeat(32)}87`);
const LEAF = p2pkh(0x22);
const RELAY = p2pkh(0x33);
const CATEGORY = `${'ab'.repeat(16)}${'cd'.repeat(16)}`;
const VAULT = hexToBin(`aa20${'55'.repeat(32)}87`);
const category = hexToBin(CATEGORY);
const expectation = { pool: POOL, contracts: [VAULT], leaf: LEAF, relay: RELAY, rewardCategory: CATEGORY, amount: 500n };

const good = (): ClaimOutput[] => [
  { lockingBytecode: POOL, valueSatoshis: 1000n, token: { category: new Uint8Array(32).fill(9), amount: 0n, nft: {} } },
  { lockingBytecode: VAULT, valueSatoshis: 1000n, token: { category, amount: 9_500n } },
  { lockingBytecode: LEAF, valueSatoshis: 1000n, token: { category, amount: 500n } },
  { lockingBytecode: RELAY, valueSatoshis: 30_000n },
];

describe('checking a claim made from the page', () => {
  it('accepts tokens to the leaf, the pool and vault outputs and the relayer change', () => {
    expect(checkPageClaim(good(), expectation)).toEqual([]);
  });

  it('refuses a wrong amount, a stranger output, tokens to the relayer and a missing pool output', () => {
    const short = good();
    short[2] = { ...short[2]!, token: { category, amount: 499n } };
    expect(checkPageClaim(short, expectation)).toEqual(['the leaf received 499 tokens, expected 500']);
    expect(checkPageClaim([...good(), { lockingBytecode: p2pkh(0x44), valueSatoshis: 546n }], expectation)[0]).toMatch(/output 4 pays/);
    const toRelay = good();
    toRelay[3] = { ...toRelay[3]!, token: { category, amount: 1n } };
    expect(checkPageClaim(toRelay, expectation)).toEqual(['output 3 gives tokens to the relayer']);
    expect(checkPageClaim(good().filter((o) => o.lockingBytecode !== POOL), expectation)).toEqual(['no output returns to the pool']);
  });

  it('does not count tokens of another category as the payment', () => {
    const other = good();
    other[2] = { ...other[2]!, token: { category: new Uint8Array(32).fill(7), amount: 500n } };
    expect(checkPageClaim(other, expectation)).toEqual(['the leaf received 0 tokens, expected 500']);
  });

  it('renders claims with explorer links and refusals as a list', () => {
    const md = renderPageClaims(
      {
        network: 'chipnet',
        claims: [{ utc: '2026-11-18T22:00:00.000Z', address: 'bchtest:qx', txid: 'ef'.repeat(32), bytes: 1900, feeSats: 1900, height: 5, paid: '500' }],
        refusals: [{ utc: '2026-11-18T22:01:00.000Z', address: 'bchtest:qx', message: 'mandatory-script-verify-flag-failed `x`' }],
      },
      [{ name: 'Explorer', txUrl: 'https://explorer.example/tx/' }],
    );
    expect(md).toContain(`| 1 | 2026-11-18 22:00:00 | \`bchtest:qx\` | [\`${'ef'.repeat(32)}\`](https://explorer.example/tx/${'ef'.repeat(32)}) | 1900 | 1900 | 5 | 500 |`);
    expect(md).toContain("- 2026-11-18 22:01:00 UTC, `bchtest:qx`: refused, `mandatory-script-verify-flag-failed 'x'`");
  });
});

describe('the committed record of claims from the page', () => {
  const record = JSON.parse(readFileSync('deployments/chipnet/page-claims.json', 'utf8')) as { network: string; claims: { txid: string; paid: string }[]; refusals: { message: string }[] };
  const measured = readFileSync('docs/MEASURED.md', 'utf8');

  it('holds at least one claim and one refusal, each listed in MEASURED', () => {
    expect(record.network).toBe('chipnet');
    expect(record.claims.length).toBeGreaterThan(0);
    expect(record.refusals.length).toBeGreaterThan(0);
    for (const c of record.claims) {
      expect(c.txid).toMatch(/^[0-9a-f]{64}$/);
      expect(BigInt(c.paid) > 0n).toBe(true);
      expect(measured).toContain(c.txid);
    }
  });
});
