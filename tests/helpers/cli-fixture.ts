// Temporary project folder with deterministic test keys and a shared mock network, for CLI tests.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockNetworkProvider, randomUtxo } from 'cashscript';
import { binToHex } from '@bitauth/libauth';
import { sha256 } from '../../src/bytes.ts';
import { main } from '../../src/cli/main.ts';
import { loadKey, makeContext, type ContextOverrides } from '../../src/cli/context.ts';
import type { NetworkName } from '../../src/config.ts';

export const ROLES = ['payer-mock', 'payer-mainnet', 'operator-1', 'operator-2', 'operator-3', 'demo-1', 'demo-2', 'demo-3'];

export interface CliFixture {
  dir: string;
  provider: MockNetworkProvider;
  lines: string[];
  run: (...argv: string[]) => Promise<{ code: number; json: Record<string, unknown> | undefined; text: string }>;
  address: (role: string, network?: NetworkName) => string;
  /** `vout` pins the output index; left out, the index is random as on a real wallet. */
  fund: (role: string, sats?: bigint, network?: NetworkName, vout?: number) => void;
  file: (name: string, content: unknown) => string;
  cleanup: () => void;
}

/** `mainnet` makes the mock network accept mainnet addresses, for tests of the mainnet budget guard. */
export function cliFixture(extra: ContextOverrides = {}, mockAs?: 'mainnet'): CliFixture {
  const dir = mkdtempSync(join(tmpdir(), 'tuai-cli-'));
  mkdirSync(join(dir, 'state', 'keys'), { recursive: true });
  for (const role of ROLES) {
    const privateKey = binToHex(sha256(new TextEncoder().encode(`tuai cli test key ${role}`)));
    writeFileSync(join(dir, 'state', 'keys', `${role}.json`), JSON.stringify({ role, privateKey }));
  }
  const provider = new MockNetworkProvider({ vmTarget: 'BCH_2026_05' });
  if (mockAs) provider.network = mockAs;
  const lines: string[] = [];
  const overrides = (): ContextOverrides => ({ repoRoot: dir, provider, out: (l) => lines.push(l), ...extra });
  const address = (role: string, network: NetworkName = 'mock') => loadKey(makeContext(network, overrides()), role).address;
  return {
    dir,
    provider,
    lines,
    async run(...argv) {
      lines.length = 0;
      const code = await main([...argv, '--json'], overrides());
      const text = lines.join('\n');
      let json: Record<string, unknown> | undefined;
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = undefined;
      }
      return { code, json, text };
    },
    address,
    fund(role, sats = 1_000_000n, network: NetworkName = 'mock', vout?: number) {
      provider.addUtxo(address(role, network), randomUtxo({ satoshis: sats, ...(vout === undefined ? {} : { vout }) }));
    },
    file(name, content) {
      const path = join(dir, name);
      writeFileSync(path, JSON.stringify(content));
      return path;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
