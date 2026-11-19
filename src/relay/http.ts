// HTTP front of the relayer (node:http, no framework). Three routes, JSON only, small bodies, never cached.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { RelayConfig } from './config.ts';
import type { RelayReply } from './service.ts';

export interface RelayHandlers {
  status(): Promise<RelayReply>;
  claim(body: unknown): Promise<RelayReply>;
  /** Wallet claims: plans an unsigned claim the user's wallet pays for. Absent = route not served. */
  prepare?(body: unknown): Promise<RelayReply>;
}

function send(res: ServerResponse, r: RelayReply): void {
  const body = JSON.stringify(r.body);
  res.writeHead(r.status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Reads at most `max` bytes; null when the body is larger. */
function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > max) {
      resolve(null);
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) over = true;
      else chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Handles one request; `log` receives a short line per request (route and result code, never key material). */
async function readJson(req: IncomingMessage, max: number): Promise<{ body: unknown } | null> {
  const raw = await readBody(req, max);
  if (raw === null) return null;
  try {
    return { body: JSON.parse(raw) };
  } catch {
    return { body: null };
  }
}

export function relayHandler(
  cfg: Pick<RelayConfig, 'statusPath' | 'healthPath' | 'claimPath' | 'maxBodyBytes'> & { wallet: Pick<RelayConfig['wallet'], 'preparePath' | 'maxBodyBytes'> },
  h: RelayHandlers,
  log: (line: string) => void,
) {
  const posts = new Map<string, { max: number; run: (body: unknown) => Promise<RelayReply> }>([[cfg.claimPath, { max: cfg.maxBodyBytes, run: h.claim }]]);
  if (h.prepare) posts.set(cfg.wallet.preparePath, { max: cfg.wallet.maxBodyBytes, run: h.prepare });
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    let r: RelayReply;
    try {
      if (path === cfg.healthPath) {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('ok\n');
        return;
      }
      if (path === cfg.statusPath && (req.method === 'GET' || req.method === 'HEAD')) r = await h.status();
      else if (posts.has(path) && req.method === 'POST') {
        const route = posts.get(path)!;
        const parsed = await readJson(req, route.max);
        r = parsed === null ? { status: 413, body: { code: 'tooLarge' } } : await route.run(parsed.body);
      } else if (path === cfg.statusPath || posts.has(path)) r = { status: 405, body: { code: 'method' } };
      else r = { status: 404, body: { code: 'notFound' } };
    } catch (e) {
      r = { status: 502, body: { code: 'chainError', message: ((e as Error).message ?? '').split('\n')[0]?.slice(0, 200) } };
    }
    log(`${new Date().toISOString()} ${req.method} ${path} ${r.status} ${String(r.body.code ?? (r.body.enabled ? 'enabled' : 'disabled'))}`);
    send(res, r);
  };
}

export function startRelayServer(port: number, handler: ReturnType<typeof relayHandler>): Server {
  const server = createServer((req, res) => void handler(req, res));
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  server.listen(port, '0.0.0.0');
  return server;
}
