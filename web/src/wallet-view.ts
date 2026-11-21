// "Claim with your own wallet" on an address card (docs/decisions/0012-wallet-claims.md). The relay prepares, this
// page checks every input and output (wallet-check.ts), the wallet signs and broadcasts. Text only via textContent.
import type { Explorer } from '../../src/explorers.ts';
import { binToHex, hashTransactionUiOrder, hexToBin } from '@bitauth/libauth';
import qrcode from 'qrcode-generator';
import { openWalletLookup } from './electrum.ts';
import { t } from './i18n.ts';
import { el } from './render.ts';
import { showAnswer } from './relay-view.ts';
import type { RelayAnswer } from './relay.ts';
import { checkPrepared, type CheckContext, type PreparedJson } from './wallet-check.ts';
import { watchBalance, type BalanceWatch } from './wallet-balance-view.ts';
import { scanWallet, walletForRelay, type ScanResult } from './wallet-scan.ts';
import { wizardHat } from './wizard-hat.ts';
import type { WalletSession } from './wizardconnect.ts';

export interface WalletViewOptions {
  address: string;
  prefix: string;
  claimable: bigint;
  amountText: string;
  check: Omit<CheckContext, 'wallet' | 'change' | 'userPrompt'>;
  preparePath: string;
  /** Address discovery limits from config (relay.wallet): gap limit, cap per key path, addresses sent to the relay. */
  scan: { gapLimit: number; maxAddressesPerScan: number; maxAddresses: number };
  relayUrls: string[];
  timeoutMs: number;
  explorers: readonly Explorer[];
  /** Where the balance chip goes while a wallet is connected (outside the card, so a redraw keeps it). */
  balance: { slot: HTMLElement; electrumUrl: string; timeoutMs: number; decimals: number; everyMs: number };
  onSent: (answer: RelayAnswer) => void;
}

/** The one open wallet session, kept after a claim so the balance chip can follow it until Disconnect. */
let open: { session: WalletSession; balance: BalanceWatch | undefined } | undefined;

function closeOpen(): void {
  const o = open;
  open = undefined;
  o?.balance?.stop();
  o?.session.close();
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

/** The pairing code as a button: pressing it copies the link, like the Copy button below it. */
function pairing(uri: string, qrUri: string, cancel: HTMLElement): Node[] {
  const copied = el('span', { class: 'chip-note', id: 'wallet-copied', role: 'status' });
  const copyButton = el('button', { type: 'button', class: 'small' }, t('walletClaim.copy'));
  const copy = () =>
    void navigator.clipboard?.writeText(uri).then(() => {
      copyButton.textContent = t('walletClaim.copied');
      copied.textContent = t('walletClaim.copied');
    });
  copyButton.addEventListener('click', copy);
  const qr = el('button', { type: 'button', class: 'qr-box', id: 'wallet-qr', title: t('walletClaim.qrCopy') }, qrSvg(qrUri));
  qr.addEventListener('click', copy);
  return [
    el('p', {}, t('walletClaim.scan')),
    qr,
    copied,
    el('p', { class: 'copy-row' }, el('a', { href: uri, id: 'wallet-open' }, t('walletClaim.open')), copyButton, cancel),
  ];
}

/** Searches the wallet's receive and change paths for coins through one Electrum connection. */
async function searchWallet(session: WalletSession, o: WalletViewOptions): Promise<ScanResult> {
  const chain = await openWalletLookup(o.balance.electrumUrl, o.balance.timeoutMs);
  try {
    return await scanWallet({
      derive: (path, index) => session.address(path, index, o.prefix),
      lookup: chain.lookup,
      gapLimit: o.scan.gapLimit,
      maxAddressesPerScan: o.scan.maxAddressesPerScan,
    });
  } finally {
    chain.close();
  }
}

/** The way to claim without a wallet: the relayer's Claim now button on this card (when it is on) and the CLI. */
function withoutWallet(): HTMLElement {
  const box = el('div', { class: 'wallet-without' }, el('p', { id: 'wallet-without' }, t('walletClaim.withoutWallet')));
  const claimNow = document.getElementById('relay-claim');
  if (claimNow instanceof HTMLButtonElement && !claimNow.disabled) {
    const go = el('button', { type: 'button', class: 'small secondary', id: 'wallet-go-claim' }, t('walletClaim.withoutWalletButton'));
    go.addEventListener('click', () => {
      claimNow.scrollIntoView({ block: 'center' });
      claimNow.focus({ preventScroll: true });
    });
    box.append(go);
  }
  return box;
}

/** Appends the wallet claim section; only called while the leaf has tokens to claim. */
export function renderWalletClaim(target: HTMLElement, o: WalletViewOptions): void {
  const out = el('div', { class: 'relay-out', id: 'wallet-out', role: 'status', 'aria-live': 'polite' });
  const start = el('button', { type: 'button', class: 'secondary wallet-connect', id: 'wallet-connect' }, wizardHat(), t('walletClaim.button')) as HTMLButtonElement;
  const say = (cls: string, ...lines: (Node | string)[]) => {
    out.className = `relay-out ${cls}`;
    out.replaceChildren(...lines.map((l) => (typeof l === 'string' ? el('p', {}, l) : l)));
  };
  let abort: AbortController | undefined;

  start.addEventListener('click', () => {
    closeOpen();
    start.disabled = true;
    abort = new AbortController();
    const signal = abort.signal;
    const cancel = el('button', { type: 'button', class: 'small', id: 'wallet-cancel' }, t('walletClaim.cancel'));
    cancel.addEventListener('click', () => abort?.abort());
    say('', t('walletClaim.loading'));
    void (async () => {
      let session: WalletSession | undefined;
      let keep = false;
      try {
        const { connectWallet } = await import('./wizardconnect.ts');
        session = await connectWallet({
          dappName: t('walletClaim.dappName'),
          relayUrls: o.relayUrls,
          signal,
          onUri: (uri, qrUri) => say('', ...pairing(uri, qrUri, cancel)),
        });
        const name = session.name || t('walletClaim.theWallet');
        say('', t('walletClaim.searching', { wallet: name }), cancel);
        const found = await searchWallet(session, o);
        const change = found.change;
        if (!change || !found.receive) throw new Error(t('walletClaim.noKeys'));
        const mine: NonNullable<typeof open> = { session, balance: undefined };
        open = mine;
        mine.balance = watchBalance(o.balance.slot, {
          ...o.balance,
          addresses: [...new Set([...found.funded, found.receive, change].map((w) => w.address))],
          rewardCategory: o.check.rewardCategory,
          onDisconnect: () => open === mine && closeOpen(),
        });
        session.onClose(() => open === mine && closeOpen());
        if (found.funded.length === 0) {
          // Nothing to spend: say where the page looked and how to claim without a wallet. The relay is not asked.
          const { receive, change: changeCount } = found.scanned;
          say('', t('walletClaim.noCoins', { receive, change: changeCount, gap: o.scan.gapLimit }), withoutWallet());
          return;
        }
        say('', t('walletClaim.preparing', { wallet: name }), cancel);
        const wallet = walletForRelay(found.funded, change, o.scan.maxAddresses);
        const p = await prepare(o.preparePath, { address: o.address, change: change.address, wallet: wallet.map((w) => w.address) }, o.timeoutMs);
        if (p.code !== 'prepared') {
          const text = t(`walletClaim.code.${CODES.has(p.code) ? p.code : 'unknown'}`, { sats: String(p.needSats ?? '') });
          say('error', text, ...(p.code === 'walletEmpty' || p.code === 'walletShort' ? [withoutWallet()] : []));
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
        showAnswer(out, answer, o.explorers);
        keep = true;
        mine.balance.refresh();
        o.onSent(answer);
      } catch (e) {
        say('error', signal.aborted ? t('walletClaim.cancelled') : t('walletClaim.failed', { message: (e as Error).message.slice(0, 200) }));
      } finally {
        // After a sent claim the session stays open for the balance chip; otherwise it ends here.
        if (!keep) {
          if (open?.session === session) closeOpen();
          else session?.close();
        }
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
