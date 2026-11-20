// The balance chip shown above the claim card while a wallet is connected (docs/decisions/0012-wallet-claims.md).
// Read from Electrum in the browser, again every few seconds while the tab is visible, until the session closes.
// Text only through textContent.
import { ElectrumSocket } from './electrum.ts';
import { t, getLocale } from './i18n.ts';
import { formatUnits, type ElectrumUtxo } from './model.ts';
import { el } from './render.ts';
import { satsToBch, sumBalance } from './wallet-balance.ts';

/** The unspent coins of each distinct address through one connection, then closes the socket. */
export async function readWalletCoins(url: string, timeoutMs: number, addresses: readonly string[]): Promise<ElectrumUtxo[][]> {
  const socket = new ElectrumSocket(url, timeoutMs);
  await socket.connect();
  try {
    await socket.request('server.version', 'tuai-web', '1.5');
    return await Promise.all(
      [...new Set(addresses)].map((a) => socket.request<ElectrumUtxo[]>('blockchain.address.listunspent', a, 'include_tokens')),
    );
  } finally {
    socket.close();
  }
}

export interface BalanceOptions {
  electrumUrl: string;
  timeoutMs: number;
  addresses: readonly string[];
  rewardCategory: string;
  decimals: number;
  everyMs: number;
  /** Called when the user presses Disconnect on the chip. */
  onDisconnect: () => void;
}

export interface BalanceWatch {
  /** Reads now, for example right after a claim was sent. */
  refresh(): void;
  /** Stops the timer and removes the chip. */
  stop(): void;
}

/** Fills `slot` with the chip and keeps it current until `stop`; the timer pauses while the tab is hidden. */
export function watchBalance(slot: HTMLElement, o: BalanceOptions): BalanceWatch {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let round = 0;
  let stopped = false;
  const bch = el('span', { class: 'chip-num', id: 'wallet-balance-bch' }, '…');
  const tokens = el('span', { class: 'chip-num', id: 'wallet-balance-tokens' }, '…');
  const note = el('span', { class: 'chip-note', id: 'wallet-balance-note' });
  const disconnect = el('button', { type: 'button', class: 'secondary small', id: 'wallet-disconnect' }, t('walletClaim.disconnect'));
  disconnect.addEventListener('click', () => o.onDisconnect());
  slot.replaceChildren(
    el('p', { class: 'chip-line' }, el('strong', {}, t('walletClaim.balanceHeading')), bch, tokens),
    el('p', { class: 'chip-line' }, note, disconnect),
  );
  slot.hidden = false;

  async function tick(): Promise<void> {
    clearTimeout(timer);
    const mine = ++round;
    if (stopped || document.hidden) return;
    slot.setAttribute('aria-busy', 'true');
    let text: string;
    try {
      const b = sumBalance(await readWalletCoins(o.electrumUrl, o.timeoutMs, o.addresses), o.rewardCategory);
      if (mine !== round || stopped) return;
      bch.textContent = t('walletClaim.balance', { bch: satsToBch(b.sats, getLocale()) });
      tokens.textContent = t('walletClaim.balanceToken', { amount: formatUnits(b.tokens, o.decimals, getLocale()) });
      text = t('walletClaim.balanceChecked', { time: new Date().toLocaleTimeString(getLocale() === 'ms' ? 'ms-MY' : 'en-GB') });
    } catch (e) {
      if (mine !== round || stopped) return;
      // The last numbers stay; the note says why they were not read again.
      text = t('walletClaim.balanceFailed', { reason: (e as Error).message.slice(0, 120) });
    }
    note.textContent = text;
    slot.removeAttribute('aria-busy');
    timer = setTimeout(() => void tick(), o.everyMs);
  }
  const onVisible = () => void tick();
  document.addEventListener('visibilitychange', onVisible);
  void tick();
  return {
    refresh: () => void tick(),
    stop() {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      slot.hidden = true;
      slot.replaceChildren();
    },
  };
}
