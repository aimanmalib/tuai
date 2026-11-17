# 0003: Root gate, two of three operators and an activation delay

Status: accepted, 2026-11-17

## Context

The pool pays against one Merkle root at a time (ADR 0002). Someone has to publish each new root. A single key
would let one compromised or careless operator replace the root at once. The bounty asks for a root authority that
is limited, visible and auditable before the root takes effect.

## Decision

1. **A third contract, `RootGate(operatorA, operatorB, operatorC, delay, poolCategory)`,** holds the
   **pending-root NFT**: the pool category's only **mutable** NFT, created next to the state NFT in the deploy
   transaction with the same commitment layout (`root(32) || epoch(4, LE) || inputsHash(32)`).
2. **`propose(sig, sig)`** needs two of the three operator keys (`OP_CHECKMULTISIG`, 2 of 3). It spends the pending
   NFT at input 0 and recreates it at output 0, at the same locking bytecode, still mutable, with the same value and a
   68-byte commitment whose epoch is not below the pending epoch. Proposing the same epoch again replaces a wrong
   root before it is activated.
   - CashScript passes a zero dummy element to `OP_CHECKMULTISIG`, which selects ECDSA mode, so the propose builder
     signs with ECDSA even when the operator keys are used for Schnorr elsewhere. It also orders the two signatures
     as the gate's key list, as the opcode requires.
   - ECDSA signatures vary in length, so the builder sizes the change from a fully signed draft.
3. **`activate()`** needs no key. Layout:

   | Index | Input | Output |
   |---|---|---|
   | 0 | state NFT (`ClaimPool.activate`) | state NFT with the pending commitment, same bytecode, category, value |
   | 1 | pending NFT (`RootGate.activate`) | pending NFT unchanged |
   | 2.. | funding without tokens | change without tokens |

   `RootGate.activate` requires `this.age >= delay` (a relative timelock: input 1's sequence number must be at
   least `delay` blocks, and consensus only accepts the transaction once the pending UTXO is that old), requires the
   pending epoch to be above the active epoch, and checks every output. `ClaimPool.activate` only checks that
   input 1 is the mutable pool NFT, so the claim path stays small; the gate script then has to run on input 1.
4. **Why each piece is safe:**
   - The mutable NFT never leaves the gate: `propose` and `activate` both put it back at the gate's own bytecode,
     and no other path can spend it. `propose` only runs at input 0 and `activate` only at input 1; a claim has the
     state NFT at input 0 and a vault UTXO at input 1, so the pending NFT cannot be burned inside a claim.
   - A look-alike NFT of another category sent to the gate address cannot become the pool root: `ClaimPool.activate`
     checks input 1's category, and `RootGate.activate` checks it again so the gate does not rely on the pool alone.
   - `ClaimPool.activate`'s category check is what binds an activation to the gate: without it, input 1 could be
     any UTXO the caller can sign for, RootGate would never run, and the state NFT could be sent anywhere.
     `tests/root-gate.test.ts` tries that attack and expects ClaimPool to refuse it.
   - An activation cannot move vault tokens or receipts even though the minting NFT is present: every input from
     index 2 must carry no tokens.
   - Re-proposing creates a new UTXO, so the delay starts again from its confirmation.
5. **Delay values** come from `config/tuai.json`: 144 blocks (about one day) for production, 3 blocks for the
   chipnet demo and 6 for a mainnet demo.

## Testing

`tests/root-gate.test.ts` runs every rejection on the CashScript mock network and checks that it fails at the
intended `require`. The mock network evaluates the script (so a sequence number below `delay` is rejected) but
does not track block heights. Maturity is consensus logic outside the script; `src/gate/maturity.ts` computes the
blocks left, and the chipnet demo records an activation refused before the delay.

## Consequences and known limits

- The delay is an audit window, not a veto: anyone can recompute a pending root from the published epoch files and
  raise an alarm, but a root two operators proposed still activates after the delay, and anyone may
  submit that activation. A one-key cancel function was considered
  and not taken, because a single faulty key could then block every epoch.
- Operator keys are fixed in the gate's bytecode. Rotating them means deploying a new gate and pool and moving the
  remaining reward tokens with the old operators' cooperation (a later extension).
- `reports/claim-sizes.json` and `docs/DEPTH.md` record the propose and activate sizes; they do not depend on the
  number of recipients.
