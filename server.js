/**
 * Free Upload Manager — Streaming Proxy Server
 *
 * Pipes the browser's PUT request directly to w.buzzheavier.com using
 * Node's native http.pipe() — zero buffering, no size limit.
 *
 * Deploy for free on Render.com:
 *   1. Push this folder to a GitHub repo
 *   2. render.com → New → Web Service → connect repo
 *   3. Build command: npm install
 *   4. Start command: node server.js
 *   5. Copy the https://<your-app>.onrender.com URL into config.js WORKER_URL
 */

const http  = require('http');
const https = require('https');
const { URL } = require('url');

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://freeuploadmanager.org';
const PORT           = process.env.PORT || 3000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin' : ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'PUT, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age'      : '86400',
};

// ── helpers ──────────────────────────────────────────────────────────────────

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(body);
}

// ── request handler ───────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const base = `http://${req.headers.host}`;
  const url  = new URL(req.url, base);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // ── PUT /api/upload/{filename} ────────────────────────────────────────────
  // True zero-copy streaming: req.pipe(buzzReq)
  // No file-size limit — the data flows through without touching Node's heap.
  if (req.method === 'PUT' && url.pathname.startsWith('/api/upload/')) {
    const filename = decodeURIComponent(url.pathname.replace('/api/upload/', ''));

    const buzzPath = '/' + encodeURIComponent(filename) +
                     (url.searchParams.get('note') ? '?note=' + url.searchParams.get('note') : '');

    const upstreamOpts = {
      hostname: 'w.buzzheavier.com',
      path    : buzzPath,
      method  : 'PUT',
      headers : {
        'Content-Type'  : req.headers['content-type']   || 'application/octet-stream',
        'Content-Length': req.headers['content-length'] || undefined,
      },
    };
    if (req.headers['authorization']) {
      upstreamOpts.headers['Authorization'] = req.headers['authorization'];
    }
    // Strip undefined values (node http module chokes on them)
    Object.keys(upstreamOpts.headers).forEach(k => {
      if (upstreamOpts.headers[k] === undefined) delete upstreamOpts.headers[k];
    });

    const buzzReq = https.request(upstreamOpts, buzzRes => {
      let body = '';
      buzzRes.on('data', chunk => { body += chunk; });
      buzzRes.on('end', () => {
        res.writeHead(buzzRes.statusCode, {
          'Content-Type': 'application/json',
          ...CORS_HEADERS,
        });
        res.end(body);
      });
    });

    buzzReq.on('error', err => {
      console.error('BuzzHeavier error:', err.message);
      sendJSON(res, 502, { error: 'Upstream error: ' + err.message });
    });

    req.on('error', err => {
      console.error('Request error:', err.message);
      buzzReq.destroy(err);
    });

    // ← The magic line: zero-copy pipe, no memory used for the file data
    req.pipe(buzzReq);
    return;
  }

  // ── GET /page/{fileId} ────────────────────────────────────────────────────
  // Fetches + patches buzzheavier's HTML page so it fits FUM's design.
  if (req.method === 'GET' && url.pathname.startsWith('/page/')) {
    const fileId = url.pathname.replace('/page/', '').split('?')[0];

    const opts = {
      hostname: 'buzzheavier.com',
      path    : '/' + fileId,
      method  : 'GET',
      headers : {
        'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    };

    const buzzReq = https.request(opts, buzzRes => {
      // Follow redirects (buzzheavier may redirect)
      if (buzzRes.statusCode >= 300 && buzzRes.statusCode < 400 && buzzRes.headers.location) {
        const loc = buzzRes.headers.location;
        res.writeHead(302, { Location: loc, ...CORS_HEADERS });
        res.end();
        return;
      }

      if (buzzRes.statusCode !== 200) {
        sendJSON(res, buzzRes.statusCode, { error: buzzRes.statusCode });
        return;
      }

      let html = '';
      buzzRes.on('data', chunk => { html += chunk; });
      buzzRes.on('end', () => {
        html = html
          .replace(/(href|src|action)="\/(?!\/)/g,  '$1="https://buzzheavier.com/')
          .replace(/(href|src|action)='\/(?!\/)/g,  "$1='https://buzzheavier.com/")
          .replace(/url\(\/(?!\/)/g,                 'url(https://buzzheavier.com/')
          .replace(/hx-(get|post|put|delete)="\/(?!\/)/g, 'hx-$1="https://buzzheavier.com/');

        const inject = '<style>html,body{background-color:#0d0d0d!important}nav,header,.navbar{display:none!important}</style>';
        html = html.includes('<head>') ? html.replace('<head>', '<head>' + inject) : inject + html;

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS });
        res.end(html);
      });
    });

    buzzReq.on('error', err => sendJSON(res, 502, { error: err.message }));
    buzzReq.end();
    return;
  }

  // ── Keepalive ──
  // GET /ping — UptimeRobot keepalive (uptimerobot.com → Add Monitor → HTTP(s) → https://din-app.onrender.com/ping)
  if (req.method === 'GET' && url.pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // 404
  sendJSON(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`FUM proxy listening on port ${PORT}`);
});


