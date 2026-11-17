#!/usr/bin/env -S npx tsx
// Tuai command line: epochs, operator transactions, claims, status and the watcher. See `tuai --help`.
import { main } from '../src/cli/main.ts';

process.exitCode = await main(process.argv.slice(2));
