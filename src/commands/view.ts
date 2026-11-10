import path from 'node:path';
import { existsSync } from 'node:fs';
import { readGraph } from '../graph/io.ts';
import { VERSION } from '../version.ts';
import { createServer, listenOnFreePort } from '../server.ts';

export interface ViewArgs {
  port?: number;
  noOpen?: boolean;
  graph?: string;
}

export async function runView(args: ViewArgs): Promise<number> {
  const graphPath = path.resolve(args.graph ?? '.nervegraph/graph.json');

  if (!existsSync(graphPath)) {
    console.error(`error: graph not found at ${graphPath}`);
    console.error('run: nerve scan');
    return 5;
  }

  // Validates the shape and rejects a schemaVersion newer than this tool.
  const graph = await readGraph(graphPath);

  const server = createServer(graphPath);
  // Bind first, probe on EADDRINUSE: a separate probe can race another process,
  // and port 0 is only known after the bind.
  const port = await listenOnFreePort(server, args.port ?? 4210);
  server.on('error', (e) => console.error(`server error: ${e.message}`));

  const scannedAgoMs = Date.now() - new Date(graph.scannedAt).getTime();
  const scannedAgo = formatAgo(scannedAgoMs);

  console.log(`nervegraph ${VERSION}`);
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
