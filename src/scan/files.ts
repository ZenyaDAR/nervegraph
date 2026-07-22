import fg from 'fast-glob';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { TEXT_EXT } from './extensions.ts';

const require = createRequire(import.meta.url);
const ignoreLib: (options?: unknown) => { add(p: unknown): unknown; ignores(p: string): boolean } = require('ignore');

const ALWAYS_IGNORE = [
  '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**',
  '**/.nervegraph/**', '**/*.min.js', '**/*.min.css', '**/vendor/**',
  '**/coverage/**', '**/.next/**', '**/.nuxt/**',
];

const MAX_FILE_SIZE = 2 * 1024 * 1024;

export interface ScannedFile {
  id: string; // posix path relative to root
  absPath: string;
  content: string;
  size: number;
  mtime: number;
}

export interface FileMeta {
  mtime: number;
  size: number;
  hash: string;
}

export interface FilesResult {
  files: ScannedFile[];
  tooLarge: string[];
  readErrors: { file: string; message: string }[];
  binaryLeaves: { id: string; size: number; mtime: number }[];
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
  // fast-glob handles ALWAYS_IGNORE directly; ignore lib handles .gitignore + extra
  if (!opts.noGitignore) {
    const gi = path.join(root, '.gitignore');
    if (existsSync(gi)) {
      ig.add(readFileSync(gi, 'utf8'));
    }
  }
  const ngi = path.join(root, '.nervegraphignore');
  if (existsSync(ngi)) {
    ig.add(readFileSync(ngi, 'utf8'));
  }
  if (opts.extraIgnore?.length) ig.add(opts.extraIgnore);

  const entries = await fg('**/*', {
    cwd: root,
    ignore: ALWAYS_IGNORE,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    absolute: false,
  });

  const relevant = entries.filter(e => !ig.ignores(e));

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

  return { files, tooLarge, readErrors, binaryLeaves };
}

export function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 8);
}
