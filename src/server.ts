import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWER_DIR = path.join(__dirname, '..', 'viewer');

const STATIC_ROUTES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/vendor/force-graph.js': { file: 'vendor/force-graph.js', type: 'text/javascript; charset=utf-8' },
};

export function createServer(graphPath: string): http.Server {
  return http.createServer(async (req, res) => {
    const url = req.url ?? '/';

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
}
