// Client of the chipnet demo relayer (docs/decisions/0009-chipnet-relayer.md). No answer means "not available".

export interface RelayStatus {
  network: string;
  enabled: boolean;
  reason?: string;
  balanceSats?: number;
  claimsLeft?: number;
}

export interface RelayAnswer {
  code: string;
  txid?: string;
  message?: string;
  local?: string;
  network?: string;
}

export async function relayStatus(path: string, timeoutMs: number): Promise<RelayStatus> {
  try {
    const res = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json()) as RelayStatus;
    if (typeof body?.enabled !== 'boolean') return { network: '', enabled: false, reason: 'unreachable' };
    return body;
  } catch {
    return { network: '', enabled: false, reason: 'unreachable' };
  }
}

export async function relayClaim(path: string, address: string, again: boolean, timeoutMs: number): Promise<RelayAnswer> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(again ? { address, again: true } : { address }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json()) as Partial<RelayAnswer>;
    return { ...body, code: typeof body.code === 'string' ? body.code : 'unknown' };
  } catch (e) {
    return { code: 'unknown', message: (e as Error).message };
  }
}
