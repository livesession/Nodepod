// Dev server for all examples. Serves from project root with cross-origin isolation headers.
// Usage: node examples/serve.js

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = 3333;

const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url.endsWith('/')) url += 'index.html';
  const file = url === '/index.html' ? '/examples/basic/index.html' : url;
  try {
    const content = readFileSync(join(root, file));
    res.writeHead(200, {
      'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(port, () => {
  console.log(`Examples server running at http://localhost:${port}`);
  console.log(`  Basic:                http://localhost:${port}/examples/basic/`);
  console.log(`  Brotli test:          http://localhost:${port}/examples/brotli-test/`);
  console.log(`  Child process test:   http://localhost:${port}/examples/child-process-test/`);
  console.log(`  Vite build test:      http://localhost:${port}/examples/vite-build-test/`);
});
