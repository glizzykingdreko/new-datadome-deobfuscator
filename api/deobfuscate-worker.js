// Runs in a worker_thread. Loads the deobfuscator and streams Logger
// calls back to the parent via postMessage as they happen — because
// deobfuscate() is synchronous + CPU-bound and would otherwise block
// the HTTP response from flushing.

const { parentPort, workerData } = require('worker_threads');
const { deobfuscate } = require('../lib');

const LEVEL = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, NONE: 4 };

class StreamLogger {
  constructor(minLevel = LEVEL.INFO, prefix = 'Deobfuscator') {
    this.level = minLevel;
    this.prefix = prefix;
    this.logs = [];
  }
  _log(numeric, name, message, data) {
    if (numeric < this.level) return;
    const entry = {
      type: 'log',
      level: name,
      message: this.prefix ? `[${this.prefix}] ${message}` : String(message),
      data: data ?? null,
      t: Date.now(),
    };
    this.logs.push(entry);
    try { parentPort.postMessage(entry); } catch {}
  }
  debug(m, d) { this._log(LEVEL.DEBUG, 'DEBUG', m, d); }
  info(m, d)  { this._log(LEVEL.INFO,  'INFO',  m, d); }
  warn(m, d)  { this._log(LEVEL.WARN,  'WARN',  m, d); }
  error(m, d) { this._log(LEVEL.ERROR, 'ERROR', m, d); }
  getLogs()   { return this.logs; }
  clear()     { this.logs = []; }
}

function summarize(r) {
  return {
    bundleType: r.bundleType,
    modules: r.modules,
    moduleOrder: r.moduleOrder,
    dynamic_challenge: r.dynamic_challenge,
    wasm: r.wasm
      ? {
          wasmBytes:        r.wasm.wasm ? r.wasm.wasm.length : 0,
          helperCount:      Array.isArray(r.wasm.helpers) ? r.wasm.helpers.length : 0,
          windowAttributes: r.wasm.windowAttributes || [],
          providerName:     r.wasm.providerName || null,
          fields:           r.wasm.fields || null,
        }
      : null,
    stats: r.stats,
    warnings: Array.isArray(r.warnings) ? r.warnings.length : (r.warnings ?? 0),
    errors: Array.isArray(r.errors)
      ? r.errors.map((e) => ({ code: e.code, message: e.message }))
      : [],
  };
}

try {
  const lvl = LEVEL[(workerData.logLevel || 'INFO').toUpperCase()] ?? LEVEL.INFO;
  const logger = new StreamLogger(lvl);

  parentPort.postMessage({ type: 'meta', t: Date.now(), bytes: workerData.source.length });
  const t0 = Date.now();
  const result = deobfuscate(workerData.source, { logger });
  parentPort.postMessage({
    type: 'result',
    t: Date.now(),
    elapsedMs: Date.now() - t0,
    data: summarize(result),
  });
} catch (err) {
  parentPort.postMessage({
    type: 'error',
    t: Date.now(),
    message: err.message,
    stack: err.stack,
  });
}
