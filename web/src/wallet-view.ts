// "Claim with your own wallet" on an address card (docs/decisions/0012-wallet-claims.md). The relay prepares, this
// page checks every input and output (wallet-check.ts), the wallet signs and broadcasts. Text only via textContent.
import { binToHex, hashTransactionUiOrder, hexToBin } from '@bitauth/libauth';
import qrcode from 'qrcode-generator';
import { t } from './i18n.ts';
import { el } from './render.ts';
import { showAnswer } from './relay-view.ts';
import type { RelayAnswer } from './relay.ts';
import { checkPrepared, type CheckContext, type PreparedJson, type WalletAddress } from './wallet-check.ts';

export interface WalletViewOptions {
  address: string;
  prefix: string;
  claimable: bigint;
  amountText: string;
  check: Omit<CheckContext, 'wallet' | 'change' | 'userPrompt'>;
  preparePath: string;
  scanAddresses: number;
  relayUrls: string[];
  timeoutMs: number;
  explorerTxUrl: string | undefined;
  onSent: (answer: RelayAnswer) => void;
}

const SVG = 'http://www.w3.org/2000/svg';
const CODES = new Set(['nothingToClaim', 'walletEmpty', 'walletShort', 'notInEpoch', 'epochMissing', 'off', 'hourFull', 'badRequest', 'badAddress',
  'wrongNetwork', 'tooManyAddresses', 'changeNotInWallet', 'tooLarge', 'guardRefused', 'spendTooHigh', 'chainError']);

/** A QR code drawn with SVG rects (no HTML strings). */
export function qrSvg(text: string): SVGSVGElement {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${n + quiet * 2} ${n + quiet * 2}`);
  svg.setAttribute('class', 'qr');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', t('walletClaim.qrLabel'));
  const bg = document.createElementNS(SVG, 'rect');
  for (const [k, v] of Object.entries({ width: '100%', height: '100%', class: 'qr-bg' })) bg.setAttribute(k, v);
  svg.append(bg);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      const cell = document.createElementNS(SVG, 'rect');
      for (const [k, v] of Object.entries({ x: c + quiet, y: r + quiet, width: 1, height: 1, class: 'qr-dot' })) cell.setAttribute(k, String(v));
      svg.append(cell);
    }
  }
  return svg;
}

async function prepare(path: string, body: unknown, timeoutMs: number): Promise<{ code: string } & Record<string, unknown>> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const b = (await res.json()) as Record<string, unknown>;
    return { ...b, code: typeof b.code === 'string' ? b.code : 'unknown' };
  } catch (e) {
    return { code: 'unknown', message: (e as Error).message };
  }
}

/** Appends the wallet claim section; only called while the leaf has tokens to claim. */
export function renderWalletClaim(target: HTMLElement, o: WalletViewOptions): void {
  const out = el('div', { class: 'relay-out', id: 'wallet-out', role: 'status', 'aria-live': 'polite' });
  const start = el('button', { type: 'button', class: 'secondary', id: 'wallet-connect' }, t('walletClaim.button')) as HTMLButtonElement;
  const say = (cls: string, ...lines: (Node | string)[]) => {
    out.className = `relay-out ${cls}`;
    out.replaceChildren(...lines.map((l) => (typeof l === 'string' ? el('p', {}, l) : l)));
  };
  let abort: AbortController | undefined;

  start.addEventListener('click', () => {
    start.disabled = true;
    abort = new AbortController();
    const signal = abort.signal;
    const cancel = el('button', { type: 'button', class: 'small', id: 'wallet-cancel' }, t('walletClaim.cancel'));
    cancel.addEventListener('click', () => abort?.abort());
    say('', t('walletClaim.loading'));
    void (async () => {
      let session: Awaited<ReturnType<typeof import('./wizardconnect.ts').connectWallet>> | undefined;
      try {
        const { connectWallet } = await import('./wizardconnect.ts');
        session = await connectWallet({
          dappName: t('walletClaim.dappName'),
          relayUrls: o.relayUrls,
          signal,
          onUri: (uri, qrUri) => {
            const copy = el('button', { type: 'button', class: 'small' }, t('walletClaim.copy'));
            copy.addEventListener('click', () => void navigator.clipboard?.writeText(uri).then(() => (copy.textContent = t('walletClaim.copied'))));
            say(
              '',
              el('p', {}, t('walletClaim.scan')),
              el('div', { class: 'qr-box' }, qrSvg(qrUri)),
              el('p', { class: 'copy-row' }, el('a', { href: uri, id: 'wallet-open' }, t('walletClaim.open')), copy, cancel),
            );
          },
        });
        say('', t('walletClaim.preparing', { wallet: session.name || t('walletClaim.theWallet') }), cancel);
        const wallet: WalletAddress[] = session.addresses(o.scanAddresses, o.prefix);
        const change = wallet.find((w) => w.path === 'change') ?? wallet[0];
        if (!change) throw new Error(t('walletClaim.noKeys'));
        const p = await prepare(o.preparePath, { address: o.address, change: change.address, wallet: wallet.map((w) => w.address) }, o.timeoutMs);
        if (p.code !== 'prepared') {
          say('error', t(`walletClaim.code.${CODES.has(p.code) ? p.code : 'unknown'}`, { sats: String(p.needSats ?? ''), count: o.scanAddresses }));
          return;
        }
        const userPrompt = t('walletClaim.prompt', { amount: o.amountText, address: o.address });
        const checked = checkPrepared(p as unknown as PreparedJson, { ...o.check, wallet, change: change.lockingBytecode, userPrompt });
        if ('refused' in checked) {
          say('error', el('p', { id: 'wallet-refused' }, t('walletClaim.refused', { reason: checked.refused })));
          return;
        }
        say('', t('walletClaim.approve', { sats: checked.spendSats.toString(), amount: o.amountText }), cancel);
        const signed = await session.sign(checked.request, checked.inputPaths, signal);
        const txid = binToHex(hashTransactionUiOrder(hexToBin(signed)));
        const answer: RelayAnswer = { code: 'claimed', txid };
        showAnswer(out, answer, o.explorerTxUrl);
        o.onSent(answer);
      } catch (e) {
        say('error', signal.aborted ? t('walletClaim.cancelled') : t('walletClaim.failed', { message: (e as Error).message.slice(0, 200) }));
      } finally {
        session?.close();
        start.disabled = false;
      }
    })();
  });

  target.append(
    el(
      'section',
      { class: 'relay', 'aria-labelledby': 'wallet-h' },
      el('h3', { id: 'wallet-h' }, t('walletClaim.heading')),
      el('p', {}, t('walletClaim.text')),
      el('div', { class: 'copy-row' }, start),
      out,
    ),
  );
}
