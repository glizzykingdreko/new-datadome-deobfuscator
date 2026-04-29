#!/usr/bin/env node
// Local dev server — serves ./public and routes POST /api/deobfuscate to api/deobfuscate.js
// Mirrors Vercel's runtime contract (req, res) so the same handler runs unchanged.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.join(__dirname, 'public');
const handler = require('./api/deobfuscate.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.statusCode = 404;
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();

  if (req.url.startsWith('/api/deobfuscate')) {
    try {
      await handler(req, res);
    } catch (err) {
      console.error('[handler error]', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: err.message || 'Internal error' }));
      }
    }
    console.log(`${req.method} ${req.url} → ${res.statusCode} (${Date.now() - t0}ms)`);
    return;
  }

  serveStatic(req, res);
  res.on('finish', () => {
    console.log(`${req.method} ${req.url} → ${res.statusCode} (${Date.now() - t0}ms)`);
  });
});

server.listen(PORT, () => {
  console.log(`\n  datadome-deobfuscator dev server`);
  console.log(`  → http://localhost:${PORT}\n`);
});
