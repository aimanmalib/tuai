import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { collectEpochFiles } from './scripts/web-epochs.ts';
import { buildTxIndex, txIndexFiles } from './scripts/tx-index.ts';

const root = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(`${root}/config/tuai.json`, 'utf8')) as {
  web: { networks: string[]; epochsPath: string; deploymentsDir: string };
  networks: Record<string, { explorerTxUrl?: string }>;
};
const { networks, epochsPath, deploymentsDir } = config.web;
const explorers = Object.fromEntries(Object.entries(config.networks).map(([n, c]) => [n, c.explorerTxUrl]));

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

export default defineConfig({
  root: 'web',
  publicDir: false,
  plugins: [epochFiles()],
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
});
