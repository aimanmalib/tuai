import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { collectEpochFiles } from './scripts/web-epochs.ts';
import { buildTxIndex, txIndexFiles } from './scripts/tx-index.ts';
import { explorersOf, type Explorer } from './src/explorers.ts';

const root = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(`${root}/config/tuai.json`, 'utf8')) as {
  web: { networks: string[]; epochsPath: string; deploymentsDir: string };
  banner: { deckUrl: string };
  networks: Record<string, { explorerTxUrl?: string; explorers?: Explorer[] }>;
};
const { networks, epochsPath, deploymentsDir } = config.web;
const explorers = Object.fromEntries(Object.entries(config.networks).map(([n, c]) => [n, explorersOf(c)]));

/** Serves the committed deployment files and the activity index under the epochs path in dev, and writes them into the build. */
function epochFiles(): Plugin {
  const files = () => [
    ...collectEpochFiles(root, deploymentsDir, networks),
    ...txIndexFiles(buildTxIndex(root, deploymentsDir, explorers)),
  ];
  return {
    name: 'tuai-epoch-files',
    configureServer(server) {
      server.middlewares.use(epochsPath, (req, res, next) => {
        const path = (req.url ?? '').split('?')[0]?.replace(/^\//, '');
        const file = files().find((f) => f.path === path);
        if (!file) return next();
        res.setHeader('Content-Type', 'application/json');
        res.end(file.body);
      });
    },
    generateBundle() {
      for (const f of files()) this.emitFile({ type: 'asset', fileName: `${epochsPath.slice(1)}/${f.path}`, source: f.body });
    },
  };
}

/**
 * Serves the slides (docs/deck.pdf) at the configured site path, so a visitor can open them while the repository is
 * still private. The page links them with a content hash query, so a CDN copy of an older deck is never shown.
 */
const deckPath = `${root}/docs/deck.pdf`;
const deckVersion = createHash('sha256').update(readFileSync(deckPath)).digest('hex').slice(0, 12);
function deckFile(): Plugin {
  const { deckUrl } = config.banner;
  return {
    name: 'tuai-deck-file',
    configureServer(server) {
      server.middlewares.use(deckUrl, (req, res, next) => {
        if (!['', '/'].includes((req.url ?? '').split('?')[0] ?? '')) return next();
        res.setHeader('Content-Type', 'application/pdf');
        res.end(readFileSync(deckPath));
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: deckUrl.slice(1), source: readFileSync(deckPath) });
    },
  };
}

export default defineConfig({
  root: 'web',
  publicDir: false,
  define: { __TUAI_DECK_VERSION__: JSON.stringify(deckVersion) },
  plugins: [epochFiles(), deckFile()],
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
});
