// Minimal Electrum JSON-RPC client over WebSocket (protocol 1.5, Fulcrum). Read-only: no keys, no broadcasts.
import type { ElectrumUtxo } from './model.ts';
import { checkTransactions, type ChainCheck } from './chain-check.ts';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class ElectrumSocket {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('timeout'));
      }, this.timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('connection failed'));
      };
      // A server that closes before opening fails the connect now, not after the timeout.
      ws.onclose = () => {
        clearTimeout(timer);
        reject(new Error('connection closed'));
        this.failAll(new Error('connection closed'));
      };
      ws.onmessage = (event: MessageEvent) => this.receive(String(event.data));
      this.ws = ws;
    });
  }

  request<T>(method: string, ...params: unknown[]): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = undefined;
  }

  private receive(text: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }
    const entry = msg.id === undefined ? undefined : this.pending.get(msg.id);
    if (!entry || msg.id === undefined) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(msg.error.message ?? 'server error'));
    else entry.resolve(msg.result);
  }

  private failAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }
}

export interface ChainReads {
  tip: number;
  pool: ElectrumUtxo[];
  gate: ElectrumUtxo[];
  vault: ElectrumUtxo[];
}

/** Reads the tip and the three contract addresses of a deployment, then closes the socket. */
export async function readChain(url: string, timeoutMs: number, contracts: { pool: string; gate: string; vault: string }): Promise<ChainReads> {
  const socket = new ElectrumSocket(url, timeoutMs);
  await socket.connect();
  try {
    await socket.request('server.version', 'tuai-web', '1.5');
    const unspent = (address: string) => socket.request<ElectrumUtxo[]>('blockchain.address.listunspent', address, 'include_tokens');
    const [tipInfo, pool, gate, vault] = await Promise.all([
      socket.request<{ height: number }>('blockchain.headers.get_tip'),
      unspent(contracts.pool),
      unspent(contracts.gate),
      unspent(contracts.vault),
    ]);
    return { tip: tipInfo.height, pool, gate, vault };
  } finally {
    socket.close();
  }
}

/** Confirmed and mempool history of each address (`blockchain.address.get_history`), then closes the socket. */
export async function readHistories(
  url: string,
  timeoutMs: number,
  addresses: readonly string[],
): Promise<Map<string, { tx_hash: string; height: number }[]>> {
  const socket = new ElectrumSocket(url, timeoutMs);
  await socket.connect();
  try {
    await socket.request('server.version', 'tuai-web', '1.5');
    const lists = await Promise.all(
      addresses.map((a) => socket.request<{ tx_hash: string; height: number }[]>('blockchain.address.get_history', a)),
    );
    return new Map(addresses.map((a, i) => [a, lists[i] ?? []]));
  } finally {
    socket.close();
  }
}

/**
 * Checks each transaction on chain through one connection and reports every verdict; when the server cannot be reached
 * or its tip cannot be read, every transaction is reported as not checked with that reason.
 */
export async function checkOnChain(
  url: string,
  timeoutMs: number,
  txids: readonly string[],
  concurrency: number,
  onResult: (txid: string, check: ChainCheck) => void,
): Promise<void> {
  if (txids.length === 0) return;
  const socket = new ElectrumSocket(url, timeoutMs);
  try {
    await socket.connect();
    await socket.request('server.version', 'tuai-web', '1.5');
    const tip = await socket.request<{ height: number }>('blockchain.headers.get_tip');
    await checkTransactions((method, ...params) => socket.request<unknown>(method, ...params), tip.height, txids, concurrency, onResult);
  } catch (e) {
    for (const txid of new Set(txids)) onResult(txid, { kind: 'error', reason: (e as Error).message });
  } finally {
    socket.close();
  }
}
