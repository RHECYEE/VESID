#!/usr/bin/env node
/*
 * Serves the site locally, the same way GitHub Pages will:
 *   node dev/serve.js [port]   ->  http://localhost:8787/  and  /map.html
 * With formLink empty in config.js, the survey shows "Setup needed" and sends nothing.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
};

function startServer(port = 8787) {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, port: server.address().port })));
}

module.exports = { startServer };

if (require.main === module) {
  startServer(Number(process.argv[2]) || 8787).then(({ port }) => {
    console.log(`Survey:    http://localhost:${port}/`);
    console.log(`Owner map: http://localhost:${port}/map.html`);
  });
}
