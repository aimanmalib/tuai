import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sha256Hex } from '../epoch/canonical.ts';

export interface DistroQuery {
  startDate: string;
  endDate: string;
  amount: number;
  includeFoldingUserTypes: number;
}

export interface ApiOptions {
  baseUrl: string;
  distroPath: string;
  cacheDir: string;
  minIntervalSeconds: number;
  timeoutSeconds: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface CachedResponse {
  bytes: Uint8Array;
  url: string;
  path: string;
  query: Record<string, string>;
  fromCache: boolean;
}

/** Thrown instead of sleeping when the last request is too recent; the caller retries later. */
export class RateLimitedError extends Error {
  constructor(readonly retryAt: Date) {
    super(`the sponsor API was called less than the minimum interval ago; retry after ${retryAt.toISOString()}`);
  }
}

const LAST_REQUEST = '.last-request';

export function distroUrl(o: Pick<ApiOptions, 'baseUrl' | 'distroPath'>, q: DistroQuery): { url: string; query: Record<string, string> } {
  if (!Number.isSafeInteger(q.amount) || q.amount <= 0) throw new RangeError('amount must be a positive whole number of tokens');
  for (const d of [q.startDate, q.endDate]) {
    if (Number.isNaN(Date.parse(d))) throw new Error(`not a date: ${d}`);
  }
  const query = {
    startDate: q.startDate,
    endDate: q.endDate,
    amount: String(q.amount),
    includeFoldingUserTypes: String(q.includeFoldingUserTypes),
  };
  const url = new URL(o.distroPath, o.baseUrl);
  for (const [k, v] of Object.entries(query)) url.searchParams.append(k, v);
  return { url: url.toString(), query };
}

/**
 * Fetches a distribution once and keeps the exact bytes. A cached response is never fetched again, and a new
 * request is refused (not delayed) when the previous one was less than `minIntervalSeconds` ago.
 */
export async function fetchDistro(o: ApiOptions, q: DistroQuery): Promise<CachedResponse> {
  const { url, query } = distroUrl(o, q);
  mkdirSync(o.cacheDir, { recursive: true });
  const cacheFile = resolve(o.cacheDir, `getdistro-${sha256Hex(url).slice(0, 16)}.json`);
  const base = { url, path: o.distroPath, query };
  if (existsSync(cacheFile)) return { ...base, bytes: readFileSync(cacheFile), fromCache: true };
  const now = (o.now ?? (() => new Date()))();
  const stamp = resolve(o.cacheDir, LAST_REQUEST);
  if (existsSync(stamp)) {
    const last = Date.parse(readFileSync(stamp, 'utf8').trim());
    const retryAt = new Date(last + o.minIntervalSeconds * 1000);
    if (!Number.isNaN(last) && retryAt > now) throw new RateLimitedError(retryAt);
  }
  writeFileSync(stamp, `${now.toISOString()}\n`);
  const response = await (o.fetch ?? fetch)(url, { signal: AbortSignal.timeout(o.timeoutSeconds * 1000) });
  if (response.status !== 200) throw new Error(`the sponsor API answered HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const body = JSON.parse(new TextDecoder().decode(bytes)) as { success?: boolean };
  if (body.success === false) throw new Error('the sponsor API reports an error for this query');
  writeFileSync(cacheFile, bytes);
  return { ...base, bytes, fromCache: false };
}
