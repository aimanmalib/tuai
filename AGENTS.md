# Notes for contributors and coding agents

- Node 22, TypeScript strict, ES modules, `tsx` for scripts, `vitest` for tests.
- Package versions are pinned exactly (no `^` or `~`). `cashc` and `cashscript` stay on the same version.
- Contracts live in `contracts/*.cash`; `npm run contracts` regenerates `src/contracts/artifacts/`.
- Values that can change belong in `config/tuai.json`; user-facing text belongs in `lang/en.json` and `lang/ms.json`
  with identical keys.
- Keep modules small (about 300 lines). One transaction builder per action under `src/tx/`.
- Run `bash scripts/gerbang-ujian.sh` before committing. It needs no network.
- Never commit keys, seed phrases or local state. Test vectors use keys derived inside the tests.
- Structured decisions go in `docs/decisions/NNNN-title.md`. Measured on-chain facts go in `docs/MEASURED.md`
  with full transaction ids and UTC times.
