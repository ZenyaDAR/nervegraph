import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWER_DIR = path.join(__dirname, '..', 'viewer');

const STATIC_ROUTES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/vendor/force-graph.js': { file: 'vendor/force-graph.js', type: 'text/javascript; charset=utf-8' },
};

/** Open viewer tabs that can subscribe to live reload at once. */
export const MAX_EVENT_CLIENTS = 32;

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?$/i;

/**
 * DNS rebinding defence: a page on evil.example whose name is re-pointed at
 * 127.0.0.1 reaches this server same-origin, but its requests still carry
 * `Host: evil.example`. Only a loopback name on the port we are bound to is
 * a request from our own viewer.
 */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  const m = LOCAL_HOST.exec(host ?? '');
  if (!m) return false;
  return Number(m[2] ?? 80) === port;
}

export function createServer(graphPath: string): http.Server {
  // Live reload: the viewer subscribes here and the server nudges it whenever
  // graph.json changes on disk, which is what `nerve scan --watch` produces.
  // One-way and text-only, so it needs no client library and no protocol.
  const clients = new Set<http.ServerResponse>();
  let notifyTimer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;

  // Watch the directory, not the file: the scan writes graph.json.tmp and
  // renames it over graph.json, and on Linux/macOS a watch on the file follows
  // the old inode and goes silent after the first rename.
  const graphName = path.basename(graphPath);
  try {
    watcher = watch(path.dirname(graphPath), (_event, file) => {
      if (file != null && String(file) !== graphName) return;
      // Editors and atomic writes fire several events per save; one debounce
      // keeps that down to a single reload.
      clearTimeout(notifyTimer);
      notifyTimer = setTimeout(() => {
        for (const client of clients) client.write('event: graph\ndata: changed\n\n');
      }, 150);
    });
    watcher.unref();
    watcher.on('error', () => { /* the directory went away; reload just stops */ });
  } catch { /* watching is a convenience; a missing watcher must not break view */ }

  const server = http.createServer(async (req, res) => {
    const port = (server.address() as AddressInfo | null)?.port ?? 0;
    if (!isAllowedHost(req.headers.host, port)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden');
      return;
    }

    // Route on the path alone, so a cache-busting `?v=` still finds the asset.
    const url = (req.url ?? '/').split('?')[0];

    if (url === '/events') {
      if (clients.size >= MAX_EVENT_CLIENTS) {
        res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '10' });
        res.end('too many live-reload connections');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (url === '/graph.json') {
      try {
        const content = await readFile(graphPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(content);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('graph.json not found — run: nerve scan');
      }
      return;
    }

    const route = STATIC_ROUTES[url];
    if (route) {
      try {
        const content = await readFile(path.join(VIEWER_DIR, route.file));
        res.writeHead(200, { 'Content-Type': route.type });
        res.end(content);
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('viewer asset missing');
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  // Otherwise an open EventSource keeps the process alive after Ctrl+C.
  server.on('close', () => {
    clearTimeout(notifyTimer);
    watcher?.close();
    for (const client of clients) client.end();
    clients.clear();
  });

  return server;
}

/**
 * Listen on `start`, or the next free port above it. Port 0 lets the OS pick.
 * Resolves to the port actually bound; rejects when none is free or the error
 * is something other than "in use", instead of crashing on an unhandled
 * 'error' event.
 */
export async function listenOnFreePort(server: http.Server, start: number, host = '127.0.0.1', attempts = 50): Promise<number> {
  const last = start === 0 ? 0 : Math.min(65535, start + attempts - 1);
  for (let port = start; port <= last; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (e: Error) => { server.off('listening', onListening); reject(e); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      return (server.address() as AddressInfo).port;
    } catch (e: any) {
      if (e?.code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error(`no free port in ${start}–${last}; pass --port <n>`);
}
