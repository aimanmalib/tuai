// Cached JSON fetches for the published files; a failed fetch is dropped from the cache so a retry goes out again.
const cache = new Map<string, Promise<unknown>>();

export function getJson<T>(path: string): Promise<T> {
  let p = cache.get(path);
  if (!p) {
    p = fetch(path, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${path}`);
      return r.json() as Promise<unknown>;
    });
    p.catch(() => cache.delete(path));
    cache.set(path, p);
  }
  return p as Promise<T>;
}
