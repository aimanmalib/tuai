// "Claim now" and "Try to claim again" on an address card, through the chipnet demo relayer. Text only via textContent.
import { t } from './i18n.ts';
import { el, explorerAnchors } from './render.ts';
import { explorerLinks, type Explorer } from '../../src/explorers.ts';
import { relayClaim, type RelayAnswer, type RelayStatus } from './relay.ts';

export interface RelayViewOptions {
  status: RelayStatus;
  address: string;
  claimable: bigint;
  claimed: bigint;
  claimPath: string;
  timeoutMs: number;
  explorers: readonly Explorer[];
  /** The outcome of the last action on this address, shown again after the card is read from the chain. */
  notice: RelayAnswer | undefined;
  /** Called after a claim was sent, to read the chain again. */
  onSent: (answer: RelayAnswer) => void;
}

const KNOWN = new Set(['nothingToClaim', 'notInEpoch', 'epochMissing', 'hourFull', 'lowBalance', 'off', 'badAddress', 'wrongNetwork',
  'badRequest', 'tooLarge', 'guardRefused', 'feeTooHigh', 'nodeRefused', 'chainError', 'notClaimedYet', 'notRefusedLocally', 'acceptedAgain']);

/** Appends the outcome of an earlier claim to `parent` where no relayer card carries it (a wallet claim on mainnet). */
export function renderNotice(parent: HTMLElement, a: RelayAnswer, explorers: readonly Explorer[]): void {
  const out = el('div', { id: 'claim-notice', role: 'status' });
  showAnswer(out, a, explorers);
  parent.append(out);
}

/** Renders the outcome of a relayer answer into `out`. */
export function showAnswer(out: HTMLElement, a: RelayAnswer, explorers: readonly Explorer[]): void {
  if (a.code === 'claimed' && a.txid) {
    const links = explorerAnchors(explorerLinks(explorers, a.txid), 'relay.explorer');
    out.className = 'relay-out ok';
    out.replaceChildren(
      el('p', {}, t('relay.done')),
      el('p', {}, el('code', { class: 'hash', id: 'relay-txid' }, a.txid)),
      links.length > 0 ? el('p', { class: 'explorer-links' }, ...links) : '',
    );
    return;
  }
  if (a.code === 'refused') {
    out.className = 'relay-out refused';
    out.replaceChildren(
      el('p', { id: 'relay-refused' }, el('strong', {}, t('relay.refused'))),
      el('p', {}, t('relay.refusedLocal', { message: a.local ?? '' })),
      el('p', {}, t('relay.refusedNode', { message: a.network ?? '' })),
    );
    return;
  }
  out.className = 'relay-out error';
  const key = KNOWN.has(a.code) ? `relay.code.${a.code}` : 'relay.code.unknown';
  out.replaceChildren(el('p', { id: 'relay-error' }, t(key, { message: a.message ?? '', txid: a.txid ?? '', code: a.code })));
}

/** Appends the relayer section to the address card; nothing when there is neither a claim nor a claim-again to offer. */
export function renderRelay(target: HTMLElement, o: RelayViewOptions): void {
  const again = o.claimable === 0n && o.claimed > 0n;
  if (o.claimable === 0n && !again) return;
  const out = el('div', { class: 'relay-out', id: 'relay-out', role: 'status', 'aria-live': 'polite' });
  if (o.notice) showAnswer(out, o.notice, o.explorers);
  const parts: HTMLElement[] = [el('h3', { id: 'relay-h' }, t('relay.heading'))];
  if (!o.status.enabled) {
    if (again) return;
    parts.push(...offParts(o.status));
  } else {
    const button = el('button', { type: 'button', class: again ? 'secondary' : 'primary', id: again ? 'relay-again' : 'relay-claim' },
      t(again ? 'relay.again' : 'relay.button')) as HTMLButtonElement;
    button.addEventListener('click', () => {
      button.disabled = true;
      out.className = 'relay-out';
      out.replaceChildren(el('p', {}, t(again ? 'relay.againWorking' : 'relay.working')));
      void relayClaim(o.claimPath, o.address, again, o.timeoutMs).then((a) => {
        showAnswer(out, a, o.explorers);
        if (a.code === 'claimed') o.onSent(a);
        else button.disabled = false;
      });
    });
    parts.push(el('p', {}, t(again ? 'relay.againText' : 'relay.text')));
    if (!again && o.status.low === true && typeof o.status.claimsLeft === 'number') {
      parts.push(el('p', { class: 'note', id: 'relay-low' }, t('relay.low', { n: o.status.claimsLeft })));
    }
    parts.push(el('div', { class: 'copy-row' }, button));
  }
  parts.push(out);
  target.append(el('section', { class: 'relay', 'aria-labelledby': 'relay-h' }, ...parts));
}

/** Without the relayer the button stays in place but switched off; a dry or switched-off relayer says what, why and what to do. */
function offParts(status: RelayStatus): HTMLElement[] {
  const reason = status.reason ?? 'off';
  const dry = reason === 'lowBalance' || reason === 'off';
  const text = dry
    ? [el('p', { class: 'note', id: 'relay-off' }, t(`relay.dry.${reason}`)), el('p', { class: 'note' }, t('relay.dry.why')),
        el('p', { class: 'note' }, t('relay.dry.todo'))]
    : [el('p', { class: 'note', id: 'relay-off' }, t('relay.off', { reason: t(`relay.reason.${reason}`) }))];
  const button = el('button', { type: 'button', class: 'primary', id: 'relay-claim', disabled: '', 'aria-describedby': 'relay-off' },
    t('relay.button'));
  return [...text, el('div', { class: 'copy-row' }, button)];
}
