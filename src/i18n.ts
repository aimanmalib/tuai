import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from './config.ts';

export type Locale = 'en' | 'ms';
type Messages = { [key: string]: string | Messages };

const cache = new Map<Locale, Messages>();

export function loadMessages(locale: Locale): Messages {
  let m = cache.get(locale);
  if (!m) {
    m = JSON.parse(readFileSync(resolve(REPO_ROOT, `lang/${locale}.json`), 'utf8')) as Messages;
    cache.set(locale, m);
  }
  return m;
}

/** Flattens nested message objects into dotted keys. */
export function flatKeys(m: Messages, prefix = ''): string[] {
  return Object.entries(m).flatMap(([k, v]) => (typeof v === 'string' ? [prefix + k] : flatKeys(v, `${prefix}${k}.`)));
}

/** Looks up a dotted key and fills {placeholders}; unknown keys throw so missing text fails loudly in tests. */
export function t(key: string, vars: Record<string, string | number> = {}, locale: Locale = 'en'): string {
  let node: string | Messages | undefined = loadMessages(locale);
  for (const part of key.split('.')) {
    node = typeof node === 'object' ? node[part] : undefined;
  }
  if (typeof node !== 'string') throw new Error(`Missing message key: ${key}`);
  return node.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}
