/** Minimal argument parser: positional words, `--flag value`, `--flag=value` and bare boolean flags. */
export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string[]>;
}

const BOOLEAN_FLAGS = new Set(['json', 'force', 'help']);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  const add = (k: string, v: string) => flags.set(k, [...(flags.get(k) ?? []), v]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      add(arg.slice(2, eq), arg.slice(eq + 1));
    } else if (BOOLEAN_FLAGS.has(arg.slice(2))) {
      add(arg.slice(2), 'true');
    } else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
      add(arg.slice(2), value);
      i += 1;
    }
  }
  return { positional, flags };
}

export const flag = (a: ParsedArgs, name: string): string | undefined => a.flags.get(name)?.at(-1);
export const flags = (a: ParsedArgs, name: string): string[] => a.flags.get(name) ?? [];
export const has = (a: ParsedArgs, name: string): boolean => a.flags.has(name);

export function requireFlag(a: ParsedArgs, name: string): string {
  const v = flag(a, name);
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
}
