import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RateLimitedError, distroUrl, fetchDistro, type ApiOptions } from '../src/api/distro.ts';
import { distroToAllocations, toAllocations, type DistroResponse } from '../src/epoch/inputs.ts';

// A real response from the sponsor API (October 2026, folding user type 8), kept small and unchanged.
const REAL = readFileSync(new URL('./fixtures/getdistro-2026-10-type8.json', import.meta.url));
const QUERY = { startDate: '2026-10-01T00:00:00Z', endDate: '2026-11-01T00:00:00Z', amount: 1000, includeFoldingUserTypes: 8 };

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function options(calls: string[], now: Date, status = 200): ApiOptions {
  dir = dir ?? mkdtempSync(join(tmpdir(), 'tuai-api-'));
  return {
    baseUrl: 'https://api.example.test',
    distroPath: '/v1/GetDistro',
    cacheDir: dir,
    minIntervalSeconds: 60,
    timeoutSeconds: 180,
    now: () => now,
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push(url);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(REAL, { status });
    }) as typeof fetch,
  };
}

describe('sponsor distribution API', () => {
  it('sends the same query parameters as the sponsor distribution script', () => {
    const { url } = distroUrl({ baseUrl: 'https://api.example.test', distroPath: '/v1/GetDistro' }, QUERY);
    const u = new URL(url);
    expect([...u.searchParams.keys()]).toEqual(['startDate', 'endDate', 'amount', 'includeFoldingUserTypes']);
    expect(u.searchParams.get('includeFoldingUserTypes')).toBe('8');
  });

  it('fetches once, then serves the exact bytes from the cache', async () => {
    const calls: string[] = [];
    const t0 = new Date('2026-11-17T10:00:00Z');
    const first = await fetchDistro(options(calls, t0), QUERY);
    const second = await fetchDistro(options(calls, t0), QUERY);
    expect(calls).toHaveLength(1);
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(Buffer.from(second.bytes).equals(REAL)).toBe(true);
  });

  it('refuses a second request inside the minimum interval instead of waiting', async () => {
    const calls: string[] = [];
    const t0 = new Date('2026-11-17T10:00:00Z');
    await fetchDistro(options(calls, t0), QUERY);
    const other = { ...QUERY, amount: 2000 };
    await expect(fetchDistro(options(calls, new Date(t0.getTime() + 59_000)), other)).rejects.toBeInstanceOf(RateLimitedError);
    expect(calls).toHaveLength(1);
    await fetchDistro(options(calls, new Date(t0.getTime() + 60_000)), other);
    expect(calls).toHaveLength(2);
  });

  it('does not cache an error answer', async () => {
    const calls: string[] = [];
    await expect(fetchDistro(options(calls, new Date('2026-11-17T10:00:00Z'), 500), QUERY)).rejects.toThrow(/HTTP 500/);
  });

  it('turns distribution amounts into base units the way the sponsor script does', () => {
    const response = JSON.parse(REAL.toString()) as DistroResponse;
    const allocations = distroToAllocations(response, 0);
    expect(allocations).toHaveLength(response.distroCount ?? -1);
    expect(allocations[0]?.amount).toBe(BigInt(Math.round((response.distro?.[0]?.amount ?? 0) * 1e8)));
    expect(allocations[0]?.lockingBytecode).toMatch(/^76a914[0-9a-f]{40}88ac$/);
    expect(() => toAllocations({ distro: [{ amount: 1, cashTokensAddress: null }] }, 0)).toThrow(/no CashTokens address/);
    expect(() => toAllocations({ success: false, distro: [] }, 0)).toThrow(/reports failure/);
  });
});
