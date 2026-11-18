// HTTP front of the relayer and `tuai relay-key`: routes, body limit, no-store, and a key that only ever shows its address.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { loadConfig } from '../src/config.ts';
import { relayHandler, startRelayServer } from '../src/relay/http.ts';
import { loadRelayKey } from '../src/relay/key.ts';
import { cliFixture, type CliFixture } from './helpers/cli-fixture.ts';

const relay = loadConfig().relay;
let server: Server | undefined;
let f: CliFixture | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
  f?.cleanup();
  f = undefined;
});

async function serve(): Promise<{ url: string; claims: unknown[] }> {
  const claims: unknown[] = [];
  const handlers = {
    status: async () => ({ status: 200, body: { network: 'chipnet', enabled: true } }),
    claim: async (body: unknown) => {
      claims.push(body);
      return { status: 200, body: { code: 'nothingToClaim' } };
    },
  };
  server = startRelayServer(0, relayHandler(relay, handlers, () => undefined));
  await new Promise((r) => server?.once('listening', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, claims };
}

describe('relay HTTP', () => {
  it('serves status and claim as JSON that is never cached', async () => {
    const s = await serve();
    const st = await fetch(`${s.url}${relay.statusPath}`);
    expect(st.status).toBe(200);
    expect(st.headers.get('cache-control')).toBe('no-store');
    expect(await st.json()).toEqual({ network: 'chipnet', enabled: true });
    const c = await fetch(`${s.url}${relay.claimPath}`, { method: 'POST', body: JSON.stringify({ address: 'bchtest:x' }) });
    expect(await c.json()).toEqual({ code: 'nothingToClaim' });
    expect(s.claims).toEqual([{ address: 'bchtest:x' }]);
    expect((await fetch(`${s.url}${relay.claimPath}`)).status).toBe(405);
    expect((await fetch(`${s.url}/api/relay/other`)).status).toBe(404);
  });

  it('refuses a body over the limit with 413 and never passes it on', async () => {
    const s = await serve();
    const big = JSON.stringify({ address: 'x'.repeat(relay.maxBodyBytes) });
    const r = await fetch(`${s.url}${relay.claimPath}`, { method: 'POST', body: big });
    expect(r.status).toBe(413);
    expect(s.claims).toEqual([]);
  });
});

describe('tuai relay-key', () => {
  it('makes a chipnet key with mode 0600, prints only the address, and never overwrites it', async () => {
    f = cliFixture();
    const made = await f.run('relay-key', '--network', 'chipnet', '--json');
    expect(made.code, made.text).toBe(0);
    const path = join(f.dir, 'state', 'keys', `${relay.keyRole}.json`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const privateKey = (JSON.parse(readFileSync(path, 'utf8')) as { privateKey: string }).privateKey;
    expect(made.text).not.toContain(privateKey);
    expect(made.json?.address).toBe(loadRelayKey(path).address);
    expect(String(made.json?.address)).toMatch(/^bchtest:q/);
    expect((await f.run('relay-key', '--network', 'chipnet')).code).toBe(1);
    expect(readFileSync(path, 'utf8')).toContain(privateKey);
  });

  it('refuses mainnet', async () => {
    f = cliFixture();
    const r = await f.run('relay-key', '--network', 'mainnet');
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/chipnet only/);
  });
});
