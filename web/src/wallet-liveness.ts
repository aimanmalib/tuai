// Noticing a lost wallet (docs/decisions/0012-wallet-claims.md, "Noticing a lost wallet"). The WizardConnect session
// only says "disconnect" when the wallet sends a Disconnect message; a wallet that closes its app or loses its network
// goes silent instead. This watcher reads the session's own events and ends the session once, when:
//   (a) the session reports `disconnect`;
//   (b) the session reports `reconnecting` and the wallet sends nothing within `graceMs`;
//   (c) a wallet that has answered a ping before stops answering for `livenessMs`.
// A wallet that never answers pings is not held to (c), so a wallet without pong support is not dropped by mistake.

/** The event surface of the session manager (an EventEmitter in the WizardConnect library). */
export interface WalletEvents {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

export type WalletState = 'live' | 'lost';

/** Rejection of anything waiting on the wallet once the session has ended. */
export class WalletEndedError extends Error {
  constructor() {
    super('ended');
    this.name = 'WalletEndedError';
  }
}

export interface LivenessWatch {
  /** Called once when the session ends, by the wallet or by the timers above. */
  onClose(listener: () => void): void;
  /** `lost` while the page waits through the grace period, `live` when the wallet speaks again. */
  onState(listener: (state: WalletState) => void): void;
  /** Settles like `work`, or rejects with WalletEndedError as soon as the session ends. */
  guard<T>(work: Promise<T>): Promise<T>;
  readonly ended: boolean;
  /** Stops the timers and listeners without ending anything (the user closed the session). */
  stop(): void;
}

const isPong = (msg: unknown): boolean => typeof msg === 'object' && msg !== null && (msg as { action?: unknown }).action === 'pong';

export function watchLiveness(events: WalletEvents, o: { graceMs: number; livenessMs: number }): LivenessWatch {
  const closeListeners: (() => void)[] = [];
  const stateListeners: ((s: WalletState) => void)[] = [];
  const waiting = new Set<() => void>();
  let ended = false;
  let stopped = false;
  let state: WalletState = 'live';
  let answersPings = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let silence: ReturnType<typeof setTimeout> | undefined;

  const setState = (s: WalletState) => {
    if (s === state) return;
    state = s;
    for (const l of stateListeners) l(s);
  };
  const end = () => {
    if (ended || stopped) return;
    ended = true;
    detach();
    for (const reject of waiting) reject();
    waiting.clear();
    for (const l of closeListeners) l();
  };
  const armSilence = () => {
    clearTimeout(silence);
    if (answersPings) silence = setTimeout(end, o.livenessMs);
  };
  /** Any message from the wallet means it is there. */
  const heard = (msg?: unknown) => {
    if (isPong(msg)) answersPings = true;
    clearTimeout(grace);
    grace = undefined;
    setState('live');
    armSilence();
  };
  const onMessage = (msg: unknown) => heard(msg);
  const onReady = () => heard();
  const onReconnecting = () => {
    setState('lost');
    if (grace === undefined) grace = setTimeout(end, o.graceMs);
  };
  const onDisconnect = () => end();
  const handlers: [string, (...a: unknown[]) => void][] = [
    ['messagereceived', onMessage],
    ['walletready', onReady],
    ['reconnecting', onReconnecting],
    ['disconnect', onDisconnect],
  ];
  for (const [e, h] of handlers) events.on(e, h);
  function detach() {
    clearTimeout(grace);
    clearTimeout(silence);
    for (const [e, h] of handlers) events.off(e, h);
  }

  return {
    onClose: (l) => void closeListeners.push(l),
    onState: (l) => void stateListeners.push(l),
    get ended() {
      return ended;
    },
    guard<T>(work: Promise<T>): Promise<T> {
      if (ended) return Promise.reject(new WalletEndedError());
      return new Promise<T>((resolve, reject) => {
        const fail = () => reject(new WalletEndedError());
        waiting.add(fail);
        work.then(
          (v) => {
            waiting.delete(fail);
            resolve(v);
          },
          (e: unknown) => {
            waiting.delete(fail);
            reject(ended ? new WalletEndedError() : e);
          },
        );
      });
    },
    stop() {
      stopped = true;
      detach();
      waiting.clear();
    },
  };
}
