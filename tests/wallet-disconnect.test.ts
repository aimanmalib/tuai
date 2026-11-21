// Noticing a lost wallet (web/src/wallet-liveness.ts, docs/decisions/0012-wallet-claims.md): a fake session manager
// (an EventEmitter like the WizardConnect one) and fake timers. The grace and liveness windows come from config.
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import config from '../config/tuai.json' with { type: 'json' };
import { validateWallet, type WalletClaimConfig } from '../src/relay/config.ts';
import { WalletEndedError, watchLiveness, type WalletEvents } from '../web/src/wallet-liveness.ts';

const W = config.relay.wallet as unknown as WalletClaimConfig;
const GRACE = W.reconnectGraceSeconds * 1000;
const LIVENESS = W.livenessSeconds * 1000;
const PING = 10_000; // the library pings every 10 s

function session() {
  const mgr = new EventEmitter();
  const events: WalletEvents = { on: (e, l) => mgr.on(e, l), off: (e, l) => mgr.off(e, l) };
  const live = watchLiveness(events, { graceMs: GRACE, livenessMs: LIVENESS });
  const closed = vi.fn();
  const states: string[] = [];
  live.onClose(closed);
  live.onState((s) => states.push(s));
  return { mgr, live, closed, states };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('noticing a lost wallet', () => {
  it('reads both windows from config, and refuses a liveness window shorter than two pings', () => {
    expect(W.reconnectGraceSeconds).toBeGreaterThanOrEqual(1);
    expect(W.livenessSeconds).toBeGreaterThanOrEqual(20);
    expect(validateWallet(W)).toEqual([]);
    expect(validateWallet({ ...W, livenessSeconds: 15 })).toContain('relay.wallet.livenessSeconds must be 20..300');
    expect(validateWallet({ ...W, reconnectGraceSeconds: 0 })).toContain('relay.wallet.reconnectGraceSeconds must be > 0');
  });

  it('(1) a disconnect from the wallet ends the session once, even when it is reported twice', () => {
    const { mgr, closed } = session();
    mgr.emit('disconnect', 'user', 'bye');
    mgr.emit('disconnect', 'user', 'bye');
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('(2) reconnecting followed by the wallet coming back within the grace period does not end the session', () => {
    const { mgr, closed, states } = session();
    mgr.emit('reconnecting');
    vi.advanceTimersByTime(GRACE - 1_000);
    mgr.emit('walletready', {});
    vi.advanceTimersByTime(GRACE * 3);
    expect(closed).not.toHaveBeenCalled();
    expect(states).toEqual(['lost', 'live']);
  });

  it('(3) reconnecting without the wallet coming back ends the session at exactly the grace period', () => {
    const { mgr, closed, states } = session();
    mgr.emit('reconnecting');
    mgr.emit('reconnecting'); // repeated reports do not restart the wait
    vi.advanceTimersByTime(GRACE - 1);
    expect(closed).not.toHaveBeenCalled();
    expect(states).toEqual(['lost']);
    vi.advanceTimersByTime(1);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('(4) a wallet that answered pings and then goes silent ends the session after the liveness window', () => {
    const { mgr, closed } = session();
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(PING);
      mgr.emit('messagereceived', { action: 'pong' });
    }
    expect(closed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(LIVENESS - 1);
    expect(closed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('(5) a wallet that never answers pings is not dropped after three liveness windows', () => {
    const { mgr, closed } = session();
    mgr.emit('messagereceived', { action: 'sign_transaction_response' });
    vi.advanceTimersByTime(LIVENESS * 3);
    expect(closed).not.toHaveBeenCalled();
  });

  it('(6) a sign request still waiting on the wallet is rejected with "ended" when the session ends', async () => {
    const { mgr, live } = session();
    const pending = live.guard(new Promise<string>(() => undefined));
    mgr.emit('disconnect');
    await expect(pending).rejects.toBeInstanceOf(WalletEndedError);
    await expect(pending).rejects.toThrow('ended');
    await expect(live.guard(Promise.resolve('late'))).rejects.toBeInstanceOf(WalletEndedError);
  });

  it('(7) closing from the page stops the watcher: no timer or later event ends the session', async () => {
    const { mgr, live, closed } = session();
    mgr.emit('messagereceived', { action: 'pong' });
    mgr.emit('reconnecting');
    live.stop();
    vi.advanceTimersByTime(LIVENESS * 3);
    mgr.emit('disconnect');
    expect(closed).not.toHaveBeenCalled();
    expect(mgr.listenerCount('disconnect')).toBe(0);
    await expect(live.guard(Promise.resolve(1))).resolves.toBe(1);
  });
});
