// Compiles every contracts/*.cash file into src/contracts/artifacts/<Name>.json with cashc.
// Run with `npm run contracts`; the gate script runs it with --check to fail on stale artifacts.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { compileFile } from 'cashc';
import { REPO_ROOT } from '../src/config.ts';

const srcDir = resolve(REPO_ROOT, 'contracts');
const outDir = resolve(REPO_ROOT, 'src/contracts/artifacts');
const check = process.argv.includes('--check');

const files = existsSync(srcDir) ? readdirSync(srcDir).filter((f) => f.endsWith('.cash')).sort() : [];
mkdirSync(outDir, { recursive: true });
let stale = 0;
for (const file of files) {
  const artifact = compileFile(resolve(srcDir, file));
  // updatedAt changes on every compile; drop it so artifacts are reproducible.
  const { updatedAt: _updatedAt, ...stable } = artifact as typeof artifact & { updatedAt?: string };
  const json = `${JSON.stringify(stable, null, 2)}\n`;
  const target = resolve(outDir, `${basename(file, '.cash')}.json`);
  if (check) {
    if (!existsSync(target) || readFileSync(target, 'utf8') !== json) {
      console.error(`stale artifact: ${target} (run npm run contracts)`);
      stale += 1;
    }
  } else {
    writeFileSync(target, json);
  }
  console.log(`${check ? 'checked' : 'compiled'} ${file}: ${artifact.bytecode.split(' ').length} ops`);
}
console.log(`${files.length} contract(s)`);
if (stale > 0) process.exit(1);
