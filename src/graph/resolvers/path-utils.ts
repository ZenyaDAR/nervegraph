import path from 'node:path';

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function normalizeJoin(fromDir: string, target: string): string {
  const joined = toPosix(path.posix.normalize(path.posix.join(fromDir, target)));
  return joined.replace(/^\.\//, '');
}

// "product-form.min.js" -> "product-form.js". Minified assets are often
// referenced directly but only the unminified source is committed to the
// theme repo, so resolvers fall back to this before giving up as missing.
export function stripMinSuffix(id: string): string | undefined {
  const m = /^(.*)\.min(\.\w+)$/.exec(id);
  return m ? m[1] + m[2] : undefined;
}
