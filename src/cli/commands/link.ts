import { readFileSync } from 'node:fs';
import { decodePrivateKeyWif } from '@bitauth/libauth';
import { hexToBinChecked } from '../../bytes.ts';
import { checkCompatLinks, readLinksFile } from '../../link/check.ts';
import { signLink, verifyLink } from '../../link/message.ts';
import { readEpochFile } from '../../epoch/file.ts';
import { flag, requireFlag, type ParsedArgs } from '../args.ts';
import type { Context } from '../context.ts';

/** Reads a private key from a file holding either a WIF or a JSON key file with a hex `privateKey`. Never prints it. */
function readKeyFile(path: string): Uint8Array {
  const text = readFileSync(path, 'utf8').trim();
  if (text.startsWith('{')) {
    const hex = (JSON.parse(text) as { privateKey?: unknown }).privateKey;
    if (typeof hex !== 'string') throw new Error(`${path} has no privateKey`);
    return hexToBinChecked(hex, 32);
  }
  const wif = decodePrivateKeyWif(text);
  if (typeof wif === 'string') throw new Error(`${path} holds neither a WIF nor a key file`);
  return wif.privateKey;
}

/**
 * `link sign --name <fah name> --address <cashaddr> --key-file <file>`: signs the compatibility link message with
 * the address's own key and prints `{ name, address, signature }` for the links file. Any wallet that signs messages
 * produces the same signature over the text in docs/SPEC.md section 8.
 */
export function linkSign(ctx: Context, a: ParsedArgs) {
  const domain = ctx.config.link.domain;
  return { domain, ...signLink(readKeyFile(requireFlag(a, 'key-file')), domain, requireFlag(a, 'name'), requireFlag(a, 'address')) };
}

/**
 * `link verify --name <n> --address <a> --signature <s>`: checks one link.
 * `link verify --links <file> [--epoch <file>]`: checks every link, and with an epoch reports which method 1 leaves
 * are verified and which stay unverified.
 */
export function linkVerify(ctx: Context, a: ParsedArgs) {
  const domain = ctx.config.link.domain;
  const linksPath = flag(a, 'links');
  if (!linksPath) {
    const r = verifyLink(domain, { name: requireFlag(a, 'name'), address: requireFlag(a, 'address'), signature: requireFlag(a, 'signature') });
    return r.ok ? { ok: true, domain } : { ok: false, domain, reason: r.reason };
  }
  const file = readLinksFile(linksPath);
  const epochPath = flag(a, 'epoch');
  if (!epochPath) {
    const results = file.links.map((l, entry) => ({ entry, name: l.name, ...verifyLink(domain, l) }));
    return { ok: results.every((r) => r.ok), domain, results };
  }
  const report = checkCompatLinks(readEpochFile(epochPath), file, domain);
  return { ok: report.invalid.length === 0, domain, ...report };
}
