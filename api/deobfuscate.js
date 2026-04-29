// POST /api/deobfuscate
//   default response          → application/json (single object)
//   ?stream=1 or Accept: ndjson → application/x-ndjson stream:
//     {type:"meta",   t, bytes}
//     {type:"log",    t, level, message, data}      ← many of these
//     {type:"result", t, elapsedMs, data:{...}}
//     {type:"error",  t, message, stack}

const path = require('path');
const { Worker } = require('worker_threads');
const { deobfuscate } = require('../lib');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5_000_000) {
        reject(new Error('Payload too large (limit 5MB)'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function extractMultipartFile(raw, boundary) {
  const marker = `--${boundary}`;
  const parts = raw.split(marker);
  for (const part of parts) {
    if (!part.includes('Content-Disposition')) continue;
    const idx = part.indexOf('\r\n\r\n');
    if (idx === -1) continue;
    let body = part.slice(idx + 4);
    if (body.endsWith('\r\n')) body = body.slice(0, -2);
    return body;
  }
  return null;
}

function wantsStream(req) {
  const accept = (req.headers['accept'] || '').toLowerCase();
  if (accept.includes('application/x-ndjson') || accept.includes('text/event-stream')) return true;
  const url = req.url || '';
  return /[?&]stream=1\b/.test(url);
}

async function readSource(req) {
  const ctype = (req.headers['content-type'] || '').toLowerCase();
  const raw = await readBody(req);

  if (ctype.startsWith('multipart/form-data')) {
    const m = ctype.match(/boundary=(.+)/);
    if (!m) throw new Error('Missing multipart boundary');
    const file = extractMultipartFile(raw, m[1].trim());
    if (!file) throw new Error('No file in form-data');
    return file;
  }
  if (ctype.includes('application/json')) {
    const parsed = JSON.parse(raw);
    return parsed.source || '';
  }
  return raw;
}

function streamWithWorker(res, source, logLevel = 'INFO') {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Disable response buffering on common reverse proxies (nginx, Vercel)
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (obj) => {
    try { res.write(JSON.stringify(obj) + '\n'); } catch {}
  };

  // Open the stream immediately so the client sees the connection alive
  send({ type: 'open', t: Date.now() });

  const worker = new Worker(path.join(__dirname, 'deobfuscate-worker.js'), {
    workerData: { source, logLevel },
  });

  let resultEmitted = false;
  let errorEmitted = false;

  worker.on('message', (msg) => {
    if (msg.type === 'result') resultEmitted = true;
    if (msg.type === 'error')  errorEmitted = true;
    send(msg);
  });
  worker.on('error', (err) => {
    errorEmitted = true;
    send({ type: 'error', t: Date.now(), message: err.message, stack: err.stack });
  });
  worker.on('exit', (code) => {
    if (!resultEmitted && !errorEmitted) {
      send({ type: 'error', t: Date.now(), message: `worker exited with code ${code}` });
    }
    send({ type: 'done', t: Date.now(), exitCode: code });
    res.end();
  });

  // Abort if the client disconnects mid-run
  res.on('close', () => {
    try { worker.terminate(); } catch {}
  });
}

function respondJson(res, source) {
  try {
    const result = deobfuscate(source, { logLevel: 'WARN' });
    const summary = {
      bundleType: result.bundleType,
      modules: result.modules,
      moduleOrder: result.moduleOrder,
      dynamic_challenge: result.dynamic_challenge,
      wasm: result.wasm
        ? {
            wasmBytes: result.wasm.wasm ? result.wasm.wasm.length : 0,
            helperCount: Array.isArray(result.wasm.helpers) ? result.wasm.helpers.length : 0,
            windowAttributes: result.wasm.windowAttributes || [],
            providerName: result.wasm.providerName || null,
            fields: result.wasm.fields || null,
          }
        : null,
      stats: result.stats,
      warnings: Array.isArray(result.warnings) ? result.warnings.length : (result.warnings ?? 0),
      errors: result.errors.map((e) => ({ code: e.code, message: e.message })),
    };
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(summary));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message, stack: err.stack }));
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  let source = '';
  try {
    source = await readSource(req);
  } catch (err) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: err.message }));
  }

  if (!source || source.length < 100) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'source must be a non-empty JS file' }));
  }

  if (wantsStream(req)) {
    // Pull log level from ?level=DEBUG|INFO|WARN|ERROR if provided
    const m = (req.url || '').match(/[?&]level=([A-Za-z]+)/);
    const logLevel = m ? m[1].toUpperCase() : 'INFO';
    return streamWithWorker(res, source, logLevel);
  }

  return respondJson(res, source);
};

module.exports.config = {
  api: {
    bodyParser: false,
    sizeLimit: '5mb',
  },
};
