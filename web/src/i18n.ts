// Page text from lang/en.json and lang/ms.json (the `web` section). Keys are the same in both files.
import en from '../../lang/en.json' with { type: 'json' };
import ms from '../../lang/ms.json' with { type: 'json' };

export type Locale = 'en' | 'ms';
type Messages = { [key: string]: string | Messages };
const ALL: Record<Locale, Messages> = { en: en.web as Messages, ms: ms.web as Messages };

let current: Locale = 'en';

export const setLocale = (locale: Locale): void => {
  current = locale;
};
export const getLocale = (): Locale => current;

/** Dotted key under `web`, with {placeholders} filled. A missing key shows the key itself so it is noticed. */
export function t(key: string, vars: Record<string, string | number> = {}): string {
  let node: string | Messages | undefined = ALL[current];
  for (const part of key.split('.')) node = typeof node === 'object' ? node[part] : undefined;
  if (typeof node !== 'string') return key;
  return node.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/** Fills every element carrying data-i18n with its text, and data-i18n-label with its accessible name. */
export function applyStatic(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n ?? '');
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-label]')) el.setAttribute('aria-label', t(el.dataset.i18nLabel ?? ''));
}
