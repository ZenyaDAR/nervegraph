import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanGo } from '../../src/scan/scanners/go.ts';
import { scanPhp } from '../../src/scan/scanners/php.ts';
import { scanJvm } from '../../src/scan/scanners/jvm.ts';
import { scanClang } from '../../src/scan/scanners/clang.ts';
import { scanMarkdown } from '../../src/scan/scanners/markdown.ts';
import { scanShell } from '../../src/scan/scanners/shell.ts';
import { scanTerraform } from '../../src/scan/scanners/terraform.ts';

const rels = (r: { rel: string; target: string; line: number }[]) => r.map(x => [x.rel, x.target, x.line]);

test('go: single and grouped imports, comments ignored', () => {
  const out = scanGo({
    id: 'main.go',
    content: `package main

import "fmt"

import (
	"os"
	alias "example.com/m/internal/store"
	// "example.com/m/skipme"
)
`,
  });
  assert.deepEqual(rels(out.refs), [
    ['go_import', 'fmt', 3],
    ['go_import', 'os', 6],
    ['go_import', 'example.com/m/internal/store', 7],
  ]);
});

test('php: require paths and use statements are different relations', () => {
  const out = scanPhp({
    id: 'src/Kernel.php',
    content: `<?php
require_once 'bootstrap.php';
use App\\Models\\User;
// use App\\Ignored\\Thing;
include("partials/header.php");
`,
  });
  assert.deepEqual(rels(out.refs), [
    ['php_require', 'bootstrap.php', 2],
    ['php_require', 'partials/header.php', 5],
    ['php_use', 'App\\Models\\User', 3],
  ]);
});

test('jvm: java and kotlin imports, wildcards skipped', () => {
  const java = scanJvm({
    id: 'src/main/java/app/Main.java',
    content: 'package app;\nimport app.svc.Store;\nimport static app.util.Text.trim;\nimport java.util.*;\n',
  });
  assert.deepEqual(rels(java.refs), [
    ['java_import', 'app.svc.Store', 2],
    ['java_import', 'app.util.Text.trim', 3],
  ]);
});

test('c: quoted includes are project files, angled ones are external', () => {
  const out = scanClang({
    id: 'src/main.c',
    content: '#include <stdio.h>\n#include "util.h"\n// #include "skipped.h"\n',
  });
  assert.deepEqual(out.refs.map(r => [r.target, r.literal, r.value]), [
    ['stdio.h', false, 'external'],
    ['util.h', true, undefined],
  ]);
});

test('markdown: links and images, code fences and anchors ignored', () => {
  const out = scanMarkdown({
    id: 'docs/index.md',
    content: `# Docs

See [the CLI](./02-cli.md) and [an anchor](#section).
![diagram](./img/graph.png)
A [site](https://example.com) link.

\`\`\`md
[not a link](./ignored.md)
\`\`\`

[ref]: ./04-scanners.md
`,
  });
  assert.deepEqual(rels(out.refs.filter(r => r.literal)), [
    ['md_link', './02-cli.md', 3],
    ['asset', './img/graph.png', 4],
    ['md_link', './04-scanners.md', 11],
  ]);
});

test('shell: literal sources resolve, interpolated ones are dynamic', () => {
  const out = scanShell({
    id: 'scripts/build.sh',
    content: '#!/bin/sh\nsource ./lib/log.sh\n. "$DIR/env.sh"\n# source ./skipped.sh\n',
  });
  assert.deepEqual(out.refs.map(r => [r.target, r.literal]), [
    ['./lib/log.sh', true],
    ['$DIR/env.sh', false],
  ]);
});

test('terraform: local module sources are project refs, registry ones are not', () => {
  const out = scanTerraform({
    id: 'main.tf',
    content: `module "vpc" {
  source = "./modules/vpc"
}

module "db" {
  source = "terraform-aws-modules/rds/aws"
}
`,
  });
  assert.deepEqual(out.refs.map(r => [r.target, r.literal]), [
    ['./modules/vpc', true],
    ['terraform-aws-modules/rds/aws', false],
  ]);
});
