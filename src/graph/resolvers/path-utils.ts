import path from 'node:path';

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

// A leading "/" means project root, not "relative to the referencing file".
// `<script src="/assets/app.js">` in pages/about.html is assets/app.js, not
// pages/assets/app.js — joining it onto fromDir silently produced a phantom
// missing node for every root-absolute reference.
export function normalizeJoin(fromDir: string, target: string): string {
  const joined = target.startsWith('/')
    ? path.posix.normalize(target.slice(1))
    : path.posix.normalize(path.posix.join(fromDir, target));
  return toPosix(joined).replace(/^\.\//, '');
}

// "product-form.min.js" -> "product-form.js". Minified assets are often
// referenced directly but only the unminified source is committed to the
// theme repo, so resolvers fall back to this before giving up as missing.
export function stripMinSuffix(id: string): string | undefined {
  const m = /^(.*)\.min(\.\w+)$/.exec(id);
  return m ? m[1] + m[2] : undefined;
}
