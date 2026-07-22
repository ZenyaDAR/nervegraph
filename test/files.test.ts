import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectFiles, hashContent } from '../src/scan/files.ts';

async function withTmpDir(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'nervegraph-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('respects .gitignore', async () => {
  await withTmpDir(async (root) => {
    await writeFile(path.join(root, '.gitignore'), 'ignored.js\n');
    await writeFile(path.join(root, 'ignored.js'), 'x');
    await writeFile(path.join(root, 'kept.js'), 'x');
    const { files } = await collectFiles(root);
    const ids = files.map(f => f.id).sort();
    assert.deepEqual(ids, ['kept.js']);
  });
});

test('noGitignore option includes otherwise-ignored files', async () => {
  await withTmpDir(async (root) => {
    await writeFile(path.join(root, '.gitignore'), 'ignored.js\n');
    await writeFile(path.join(root, 'ignored.js'), 'x');
    const { files } = await collectFiles(root, { noGitignore: true });
    assert.ok(files.some(f => f.id === 'ignored.js'));
  });
});

test('always ignores node_modules regardless of gitignore', async () => {
  await withTmpDir(async (root) => {
    await mkdir(path.join(root, 'node_modules'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'dep.js'), 'x');
    await writeFile(path.join(root, 'kept.js'), 'x');
    const { files } = await collectFiles(root, { noGitignore: true });
    const ids = files.map(f => f.id);
    assert.ok(!ids.includes('node_modules/dep.js'));
    assert.ok(ids.includes('kept.js'));
  });
});

test('non-text extensions are reported as binary leaves, not scanned files', async () => {
  await withTmpDir(async (root) => {
    await writeFile(path.join(root, 'image.png'), 'x');
    const { files, binaryLeaves } = await collectFiles(root);
    assert.equal(files.length, 0);
    assert.equal(binaryLeaves.length, 1);
    assert.equal(binaryLeaves[0].id, 'image.png');
  });
});

test('files over MAX_FILE_SIZE are reported as tooLarge, not read', async () => {
  await withTmpDir(async (root) => {
    await writeFile(path.join(root, 'big.js'), 'x'.repeat(2 * 1024 * 1024 + 1));
    const { files, tooLarge } = await collectFiles(root);
    assert.equal(files.length, 0);
    assert.deepEqual(tooLarge, ['big.js']);
  });
});

test('UTF-8 BOM is stripped from file content', async () => {
  await withTmpDir(async (root) => {
    await writeFile(path.join(root, 'bom.js'), '﻿const x = 1;');
    const { files } = await collectFiles(root);
    assert.equal(files[0].content, 'const x = 1;');
  });
});

test('hashContent is deterministic for identical content', () => {
  assert.equal(hashContent('same'), hashContent('same'));
  assert.notEqual(hashContent('a'), hashContent('b'));
});
