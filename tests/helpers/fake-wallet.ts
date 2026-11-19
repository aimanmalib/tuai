// An in-process stand-in for a WizardConnect wallet: it holds test keys by (path, index), signs exactly the inputs a
// sign request names with SIGHASH_ALL | SIGHASH_FORKID | SIGHASH_UTXOS, and returns the signed transaction hex.
import { binToHex, encodeDataPush, encodeTransaction, flattenBinArray, hash256, hexToBin } from '@bitauth/libauth';
import { SighashType, SignatureTemplate } from 'cashscript';
import { createSighashPreimage } from 'cashscript/dist/utils.js';
import type { WalletSignRequest } from '../../web/src/wallet-check.ts';
import { testKey, type TestKey } from './pool-fixture.ts';

export interface FakeWallet {
  key(path: string, index: number): TestKey;
  sign(request: WalletSignRequest, inputPaths: readonly [number, string, number][]): string;
}

export function fakeWallet(seed: string): FakeWallet {
  const key = (path: string, index: number) => testKey(`${seed} ${path} ${index}`);
  const hashtype = SighashType.SIGHASH_ALL | SighashType.SIGHASH_UTXOS;
  return {
    key,
    sign(request, inputPaths) {
      const tx = { ...request.transaction, inputs: request.transaction.inputs.map((i) => ({ ...i })) };
      for (const [i, path, index] of inputPaths) {
        const k = key(path, index);
        const source = request.sourceOutputs[i];
        if (!source) throw new Error(`no source output ${i}`);
        const preimage = createSighashPreimage(tx, request.sourceOutputs, i, source.lockingBytecode, hashtype);
        const signer = new SignatureTemplate(k.signer.privateKey, hashtype);
        const signature = signer.generateSignature(hash256(preimage));
        (tx.inputs[i] as { unlockingBytecode: Uint8Array }).unlockingBytecode = flattenBinArray([
          encodeDataPush(signature),
          encodeDataPush(hexToBin(k.publicKey)),
        ]);
      }
      return binToHex(encodeTransaction(tx));
    },
  };
}
