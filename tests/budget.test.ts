import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BudgetExceededError, checkBudget, readLedger } from '../src/cli/budget.ts';
import { cliFixture, type CliFixture } from './helpers/cli-fixture.ts';
import { loadConfig } from '../src/config.ts';

let f: CliFixture;
afterEach(() => f?.cleanup());

const LIMIT = loadConfig().budget.mainnetMaxSats;

function seedLedger(fx: CliFixture, total: number) {
  mkdirSync(join(fx.dir, 'state'), { recursive: true });
  writeFileSync(join(fx.dir, 'state/belanja.json'), JSON.stringify({ total_sats: total, entries: [{ txid: 'aa'.repeat(32), sats: total, utc: '2026-11-17T00:00:00Z', kind: 'seed' }] }));
}

describe('mainnet budget guard', () => {
  it('allows spending up to the limit and refuses one satoshi more', () => {
    const ledger = { total_sats: LIMIT - 10, entries: [] };
    expect(() => checkBudget(ledger, 10, LIMIT)).not.toThrow();
    expect(() => checkBudget(ledger, 11, LIMIT)).toThrow(BudgetExceededError);
  });

  it('refuses a mainnet broadcast that would pass the limit and sends nothing', async () => {
    f = cliFixture({}, 'mainnet');
    f.fund('payer-mainnet', 100_000n, 'mainnet');
    seedLedger(f, LIMIT - 100);
    const payer = f.address('payer-mainnet', 'mainnet');
    const before = await f.provider.getUtxos(payer);
    const r = await f.run('token', 'genesis', '--amount', '1000', '--network', 'mainnet');
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/budget exceeded/i);
    expect(await f.provider.getUtxos(payer)).toEqual(before);
    expect(readLedger(join(f.dir, 'state/belanja.json')).total_sats).toBe(LIMIT - 100);
  });

  it('records every mainnet broadcast in the ledger and the run log', async () => {
    f = cliFixture({}, 'mainnet');
    f.fund('payer-mainnet', 100_000n, 'mainnet');
    const r = await f.run('token', 'genesis', '--amount', '1000', '--network', 'mainnet');
    expect(r.code, r.text).toBe(0);
    const ledger = readLedger(join(f.dir, 'state/belanja.json'));
    expect(ledger.entries.map((e) => e.kind)).toEqual(['prepare-genesis', 'token-genesis']);
    const runs = JSON.parse(readFileSync(join(f.dir, 'state/runs/mainnet.json'), 'utf8')) as { txs: Array<{ txid: string; feeSats: number }> };
    expect(runs.txs.map((t) => t.txid)).toEqual(ledger.entries.map((e) => e.txid));
    // both outputs stay in the project wallet, so only the fees count as spent
    expect(ledger.total_sats).toBe(runs.txs.reduce((s, t) => s + t.feeSats, 0));
    expect(ledger.total_sats).toBeGreaterThan(0);
    const b = await f.run('budget', '--network', 'mainnet');
    expect(b.json).toMatchObject({ spent: ledger.total_sats, limit: LIMIT, remaining: LIMIT - ledger.total_sats });
  });

  it('keeps chipnet spending out of the mainnet ledger', async () => {
    f = cliFixture();
    f.fund('payer-mock');
    expect((await f.run('token', 'genesis', '--amount', '1000', '--network', 'mock')).code).toBe(0);
    expect(existsSync(join(f.dir, 'state/belanja.json'))).toBe(false);
  });
});
