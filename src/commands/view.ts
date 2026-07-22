import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { readGraph } from '../graph/io.ts';
import { createServer } from '../server.ts';
import { SCHEMA_VERSION } from '../graph/types.ts';

export interface ViewArgs {
  port?: number;
  noOpen?: boolean;
  graph?: string;
}

async function findFreePort(start: number): Promise<number> {
  const net = await import('node:net');
  let port = start;
  // ponytail: linear probe, fine for a local dev server on a handful of ports
  for (let i = 0; i < 50; i++) {
    const free = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(port, '127.0.0.1');
    });
    if (free) return port;
    port++;
  }
  return start;
}

export async function runView(args: ViewArgs): Promise<number> {
  const graphPath = path.resolve(args.graph ?? '.nervegraph/graph.json');

  if (!existsSync(graphPath)) {
    console.error(`error: graph not found at ${graphPath}`);
    console.error('run: nerve scan');
    return 5;
  }

  const graph = await readGraph(graphPath);
  if (graph.schemaVersion > SCHEMA_VERSION) {
    console.error(`error: graph.json schemaVersion (${graph.schemaVersion}) is newer than this tool understands (${SCHEMA_VERSION}).`);
    console.error('update nervegraph and try again.');
    return 6;
  }

  const port = await findFreePort(args.port ?? 4210);
  const server = createServer(graphPath);

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

  const scannedAgoMs = Date.now() - new Date(graph.scannedAt).getTime();
  const scannedAgo = formatAgo(scannedAgoMs);

  console.log('nervegraph 0.1.0');
  console.log('');
  console.log(`  graph   ${graphPath}  ·  ${graph.nodes.length} nodes · ${graph.edges.length} edges`);
  console.log(`  scanned ${scannedAgo}`);
  if (scannedAgoMs > 24 * 60 * 60 * 1000) {
    console.log('  ⚠ graph is stale, run: nerve scan');
  }
  console.log('');
  console.log(`  ➜  http://localhost:${port}`);
  console.log('');
  console.log('  press Ctrl+C to stop');

  if (!args.noOpen) {
    await openBrowser(`http://localhost:${port}`);
  }

  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => { server.close(() => resolve()); });
  });

  return 0;
}

function formatAgo(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} seconds ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minutes ago`;
  const hr = Math.floor(min / 60);
  return `${hr} hours ago`;
}

async function openBrowser(url: string): Promise<void> {
  const { exec } = await import('node:child_process');
  const platform = process.platform;
  const cmd = platform === 'darwin' ? `open "${url}"` : platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}
