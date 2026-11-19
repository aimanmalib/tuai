import { describe, expect, it } from 'vitest';
import { loadConfig, validateConfig, type TuaiConfig } from '../src/config.ts';
import { flatKeys, loadMessages, t } from '../src/i18n.ts';

const clone = (): TuaiConfig => structuredClone(loadConfig());

describe('config/tuai.json', () => {
  it('loads and validates', () => {
    expect(validateConfig(loadConfig())).toEqual([]);
  });

  it('defines every network with a delay', () => {
    const c = loadConfig();
    for (const n of ['mock', 'chipnet', 'mainnet'] as const) {
      expect(c.networks[n].activationDelayBlocks).toBeGreaterThan(0);
    }
  });

  it('rejects a threshold above the operator count', () => {
    const c = clone();
    c.operators.threshold = c.operators.total + 1;
    expect(validateConfig(c).join()).toMatch(/operators.threshold/);
  });

  it('rejects a tree deeper than 32 levels', () => {
    const c = clone();
    c.tree.maxDepth = 33;
    expect(validateConfig(c).join()).toMatch(/maxDepth/);
  });

  it('rejects a shard count outside 1..64', () => {
    for (const shards of [0, 65, 1.5]) {
      const c = clone();
      c.pool.shards = shards;
      expect(validateConfig(c).join()).toMatch(/pool\.shards/);
    }
  });

  it('rejects an invalid cost comparison setup', () => {
    const c = clone();
    c.cost.recipientCounts = [0];
    c.cost.sponsorCategory = 'xyz';
    const problems = validateConfig(c).join();
    expect(problems).toMatch(/cost.recipientCounts/);
    expect(problems).toMatch(/cost.sponsorCategory/);
  });

  it('rejects a sponsor API interval below one minute', () => {
    const c = clone();
    c.sponsorApi.minIntervalSeconds = 10;
    expect(validateConfig(c).join()).toMatch(/minIntervalSeconds/);
  });

  it('rejects malformed operator keys and categories', () => {
    const c = clone();
    c.operators.publicKeys = ['02', '03', '04'];
    c.networks.chipnet.rewardCategory = 'xyz';
    const problems = validateConfig(c).join();
    expect(problems).toMatch(/publicKeys/);
    expect(problems).toMatch(/rewardCategory/);
  });

  it('rejects a timelock that does not fit a relative block lock', () => {
    const c = clone();
    c.networks.mainnet.activationDelayBlocks = 70_000;
    expect(validateConfig(c).join()).toMatch(/activationDelayBlocks/);
  });
});

describe('lang files', () => {
  it('have the same keys in English and Malay', () => {
    expect(flatKeys(loadMessages('ms')).sort()).toEqual(flatKeys(loadMessages('en')).sort());
  });

  it('fill placeholders', () => {
    expect(t('cli.unknownCommand', { command: 'x' })).toContain('x');
    expect(t('cli.unknownCommand', { command: 'x' }, 'ms')).toContain('x');
  });

  it('throw on a missing key', () => {
    expect(() => t('cli.nope')).toThrow(/Missing message key/);
  });
});
