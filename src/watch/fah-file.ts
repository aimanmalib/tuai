import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

/**
 * Streams a Folding@home daily user summary line by line, plain text or `.bz2` (decompressed with `bzip2 -dc`),
 * so the multi-million line file is never held in memory.
 */
export async function eachFahLine(path: string, onLine: (line: string) => void): Promise<void> {
  const compressed = path.endsWith('.bz2');
  const child = compressed ? spawn('bzip2', ['-dc', path], { stdio: ['ignore', 'pipe', 'inherit'] }) : undefined;
  const input: Readable = child ? child.stdout : createReadStream(path, 'utf8');
  for await (const line of createInterface({ input, crlfDelay: Infinity })) onLine(line);
  if (child) {
    const code = child.exitCode ?? (await new Promise<number | null>((done) => child.on('close', done)));
    if (code !== 0) throw new Error(`bzip2 exited with ${code}`);
  }
}
