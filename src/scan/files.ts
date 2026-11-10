import fg from 'fast-glob';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { TEXT_EXT } from './extensions.ts';

const require = createRequire(import.meta.url);
const ignoreLib: (options?: unknown) => { add(p: unknown): unknown; ignores(p: string): boolean } = require('ignore');

// Never listed at all.
const NEVER_LIST = [
  '**/node_modules/**', '**/.git/**', '**/.git',
  '**/.nervegraph/**', '**/coverage/**', '**/.next/**', '**/.nuxt/**',
];
// Listed (so imports of them resolve) but never scanned.
const LIST_ONLY = ['**/dist/**', '**/build/**', '**/*.min.js', '**/*.min.css', '**/vendor/**'];
const ALWAYS_IGNORE = [...NEVER_LIST, ...LIST_ONLY];

const MAX_FILE_SIZE = 2 * 1024 * 1024;

export interface ScannedFile {
  id: string; // posix path relative to root
  absPath: string;
  content: string;
  size: number;
  mtime: number;
}

export interface FilesResult {
  files: ScannedFile[];
  tooLarge: string[];
  readErrors: { file: string; message: string }[];
  binaryLeaves: { id: string; size: number; mtime: number }[];
  /** On disk but excluded by .gitignore / .nervegraphignore / extraIgnore. */
  ignored: string[];
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export async function collectFiles(root: string, opts: {
  extraIgnore?: string[];
  noGitignore?: boolean;
} = {}): Promise<FilesResult> {
  const ig = ignoreLib();
  ig.add(ALWAYS_IGNORE.map(p => p.replace(/^\*\*\//, '').replace(/\/\*\*$/, '')));
  // fast-glob drops NEVER_LIST; ignore lib moves LIST_ONLY, .gitignore and extra into `ignored`
  const ngi = path.join(root, '.nervegraphignore');
  if (existsSync(ngi)) {
    ig.add(readFileSync(ngi, 'utf8'));
  }
  if (opts.extraIgnore?.length) ig.add(opts.extraIgnore);

  // Dotted paths are real project files (.storybook/main.ts, .config.js);
  // only the always-ignored ones (.git, .next, …) are skipped.
  const entries = (await fg('**/*', {
    cwd: root,
    ignore: NEVER_LIST,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    absolute: false,
  })).sort();

  // Every .gitignore applies to its own directory and below, with patterns
  // relative to that directory — not only the root one.
  const gitignores: { dir: string; ig: ReturnType<typeof ignoreLib> }[] = [];
  if (!opts.noGitignore) {
    for (const e of entries) {
      if (e !== '.gitignore' && !e.endsWith('/.gitignore')) continue;
      const dir = e.slice(0, -'.gitignore'.length);
      const gi = ignoreLib();
      gi.add(readFileSync(path.join(root, e), 'utf8'));
      gitignores.push({ dir, ig: gi });
    }
  }
  const isIgnored = (e: string) =>
    ig.ignores(e) || gitignores.some(g => e.startsWith(g.dir) && g.ig.ignores(e.slice(g.dir.length)));

  const relevant: string[] = [];
  // Ignored files are not scanned, but they are on disk: an import of a
  // gitignored generated file must not become a "missing" node.
  const ignored: string[] = [];
  for (const e of entries) (isIgnored(e) ? ignored : relevant).push(e);

  const files: ScannedFile[] = [];
  const tooLarge: string[] = [];
  const readErrors: { file: string; message: string }[] = [];
  const binaryLeaves: { id: string; size: number; mtime: number }[] = [];

  const CONCURRENCY = Math.min(8, Math.max(1, (globalThis as any).process?.availableParallelism?.() ?? 4));
  let idx = 0;

  async function worker() {
    while (idx < relevant.length) {
      const rel = relevant[idx++];
      const id = toPosix(rel);
      const absPath = path.join(root, rel);
      try {
        const st = await stat(absPath);
        if (st.size > MAX_FILE_SIZE) {
          tooLarge.push(id);
          continue;
        }
        const ext = path.extname(rel).toLowerCase();
        if (!TEXT_EXT.has(ext)) {
          binaryLeaves.push({ id, size: st.size, mtime: st.mtimeMs });
          continue;
        }
        let content = await readFile(absPath, 'utf8');
        if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
        files.push({ id, absPath, content, size: st.size, mtime: st.mtimeMs });
      } catch (e: any) {
        readErrors.push({ file: id, message: e?.message ?? String(e) });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // Workers finish in whatever order the disk answers; sort so two scans of
  // the same tree produce the same graph.
  const byId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  files.sort((a, b) => byId(a.id, b.id));
  binaryLeaves.sort((a, b) => byId(a.id, b.id));
  readErrors.sort((a, b) => byId(a.file, b.file));
  tooLarge.sort(byId);

  return { files, tooLarge, readErrors, binaryLeaves, ignored: ignored.map(toPosix) };
}

export function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 8);
}
