(() => {
  const $ = (id) => document.getElementById(id);

  const drop          = $('drop');
  const dropwrap      = $('dropwrap');
  const fileInput     = $('fileInput');
  const dropPrimary   = $('dropPrimary');
  const fileMeta      = $('fileMeta');
  const runBtn        = $('runBtn');
  const resetBtn      = $('resetBtn');
  const status        = $('status');
  const statusLabel   = $('statusLabel');
  const results       = $('results');
  const tabs          = $('tabs');
  const codeBody      = $('codeBody');
  const downloadBtn   = $('downloadBtn');
  const copyBtn       = $('copyBtn');
  const downloadOneBtn= $('downloadOneBtn');
  const bundleType    = $('bundleType');
  const bundleHint    = $('bundleHint');
  const moduleCount   = $('moduleCount');
  const statOriginal  = $('statOriginal');
  const statDeob      = $('statDeob');
  const statReduction = $('statReduction');
  const statWarn      = $('statWarn');
  const dcBody        = $('dcBody');
  const dcCode        = $('dcCode') || dcBody;
  const dcHint        = $('dcHint');
  const wasmBody      = $('wasmBody');
  const wasmHint      = $('wasmHint');
  const logwin        = $('logwin');
  const consoleHint   = $('consoleHint');
  const consoleClear  = $('consoleClear');
  const consoleSave   = $('consoleSave');
  const consoleFollow = $('consoleFollow');
  const metaConsole   = $('metaConsole');

  let currentFile  = null;
  let lastResult   = null;
  let activeModule = null;
  let logCount     = 0;
  let logBuffer    = [];   // every log entry, in order, for download

  // ---- helpers --------------------------------------------
  function formatBytes(n) {
    if (n == null || isNaN(n)) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  function setStatus(state, label) {
    status.dataset.state = state;
    statusLabel.textContent = label;
  }

  function setFile(f) {
    currentFile = f || null;
    if (!f) {
      dropPrimary.textContent = '—';
      fileMeta.textContent = 'no file';
      runBtn.disabled = true;
      return;
    }
    dropPrimary.textContent = f.name;
    fileMeta.textContent = `${formatBytes(f.size)} · ready`;
    runBtn.disabled = false;
  }

  function showEditor(yes) {
    dropwrap.hidden = yes;
    results.hidden  = !yes;
  }

  function resetExplorer() {
    tabs.innerHTML = '<div class="rail__empty">no file loaded</div>';
    bundleHint.textContent = '—';
    downloadBtn.hidden = true;
  }

  // ---- DnD ------------------------------------------------
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('is-dragging');
    }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === 'dragleave' && e.target !== drop) return;
      drop.classList.remove('is-dragging');
    }),
  );
  drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) setFile(f);
  });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) setFile(f);
  });

  // ---- console panel --------------------------------------
  // Pin-to-bottom auto-scroll: stays glued unless the user scrolls up,
  // resumes the moment they reach the bottom again. A floating "↓ follow"
  // chip surfaces when paused so it's never a guessing game.
  let pinnedToBottom = true;
  let suppressScrollEvent = false;
  let followChip = null;

  function setHintCount() {
    consoleHint.textContent = `${logCount} ${logCount === 1 ? 'entry' : 'entries'}` +
      (pinnedToBottom ? '' : ' · paused');
  }

  function clearLogs() {
    logwin.innerHTML = '';
    logCount = 0;
    logBuffer = [];
    pinnedToBottom = true;
    consoleSave.hidden = true;
    setHintCount();
    updateFollowChip();
  }

  function fmtTime(t) {
    const d = new Date(t || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3,'0')}`;
  }

  function isAtBottom() {
    return logwin.scrollTop + logwin.clientHeight >= logwin.scrollHeight - 4;
  }

  function scrollToBottom() {
    suppressScrollEvent = true;
    logwin.scrollTop = logwin.scrollHeight;
    // release suppression on next tick (after the scroll event fires)
    requestAnimationFrame(() => { suppressScrollEvent = false; });
  }

  function updateFollowChip() {
    if (consoleFollow) consoleFollow.hidden = pinnedToBottom;
  }

  consoleFollow?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    pinnedToBottom = true;
    scrollToBottom();
    setHintCount();
    updateFollowChip();
  });

  logwin.addEventListener('scroll', () => {
    if (suppressScrollEvent) return;
    const atBottom = isAtBottom();
    if (atBottom !== pinnedToBottom) {
      pinnedToBottom = atBottom;
      setHintCount();
      updateFollowChip();
    }
  }, { passive: true });

  function appendLog({ level = 'INFO', message = '', t, kind = '' }) {
    const ts = t || Date.now();

    // capture for download — full fidelity even if DOM rows get pruned
    logBuffer.push({ t: ts, level, message: String(message), kind: kind || level.toLowerCase() });
    consoleSave.hidden = false;

    const row = document.createElement('div');
    row.className = `log log--${kind || level.toLowerCase()}`;

    const tEl = document.createElement('span');
    tEl.className = 'log__t';
    tEl.textContent = fmtTime(ts);

    const lEl = document.createElement('span');
    lEl.className = 'log__lvl';
    lEl.textContent = level;

    // <pre> preserves newlines + wraps long tokens via overflow-wrap
    const mEl = document.createElement('pre');
    mEl.className = 'log__msg';
    mEl.textContent = message;

    row.append(tEl, lEl, mEl);

    // bound visible DOM at 2000 rows (logBuffer keeps everything)
    if (logwin.childElementCount >= 2000) logwin.firstElementChild?.remove();
    logwin.appendChild(row);

    if (pinnedToBottom) scrollToBottom();

    logCount += 1;
    setHintCount();
  }

  function logsAsText() {
    return logBuffer
      .map((e) => `[${new Date(e.t).toISOString()}] [${e.level.padEnd(5)}] ${e.message}`)
      .join('\n');
  }

  consoleSave?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!logBuffer.length) return;
    const blob = new Blob([logsAsText() + '\n'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `deob-logs-${stamp}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  consoleClear.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearLogs();
  });

  // ---- Run (streaming) ------------------------------------
  async function runStreaming() {
    runBtn.disabled = true;
    setStatus('running', 'running…');
    clearLogs();
    consoleClear.hidden = false;
    metaConsole.classList.add('meta--streaming');
    metaConsole.open = true;
    // expose results pane immediately so user sees logs flowing
    showEditor(true);

    const t0 = performance.now();

    try {
      const source = await currentFile.text();
      appendLog({ level: 'META', kind: 'meta', message: `→ POST /api/deobfuscate?stream=1  · ${formatBytes(source.length)}` });

      const res = await fetch('/api/deobfuscate?stream=1&level=INFO', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify({ source }),
      });

      if (!res.ok || !res.body) {
        const txt = await res.text().catch(() => '');
        let msg = `HTTP ${res.status}`;
        try { msg = JSON.parse(txt).error || msg; } catch {}
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      let resultData = null;
      let errorMsg = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;

          let evt;
          try { evt = JSON.parse(line); } catch { continue; }

          switch (evt.type) {
            case 'open':
              appendLog({ level: 'META', kind: 'meta', t: evt.t, message: '… connection open, worker spawning' });
              break;
            case 'meta':
              appendLog({ level: 'META', kind: 'meta', t: evt.t, message: `worker ready · ${formatBytes(evt.bytes)} input` });
              break;
            case 'log':
              appendLog({ level: evt.level || 'INFO', t: evt.t, message: evt.message || '' });
              break;
            case 'result':
              resultData = evt.data;
              appendLog({ level: 'META', kind: 'meta', t: evt.t, message: `result emitted in ${(evt.elapsedMs/1000).toFixed(2)}s` });
              break;
            case 'error':
              errorMsg = evt.message || 'unknown error';
              appendLog({ level: 'ERROR', t: evt.t, message: evt.message || 'error' });
              break;
            case 'done':
              appendLog({ level: 'META', kind: 'meta', t: evt.t, message: `done · exit ${evt.exitCode}` });
              break;
          }
        }
      }

      if (errorMsg && !resultData) throw new Error(errorMsg);
      if (!resultData) throw new Error('stream ended without result');

      lastResult = resultData;
      renderResults(resultData);

      const dt = ((performance.now() - t0) / 1000).toFixed(2);
      setStatus('ok', `ok · ${dt}s`);
      resetBtn.hidden = false;
      downloadBtn.hidden = false;
      copyBtn.hidden = false;
      downloadOneBtn.hidden = false;
    } catch (err) {
      console.error(err);
      setStatus('error', `error · ${(err.message || '').toLowerCase()}`);
      appendLog({ level: 'ERROR', message: err.message || String(err) });
      // keep editor open so the user can see the logs even on failure
    } finally {
      runBtn.disabled = !currentFile;
      metaConsole.classList.remove('meta--streaming');
    }
  }

  runBtn.addEventListener('click', () => {
    if (!currentFile) return;
    runStreaming();
  });

  // Tear the page back down to the empty drop state.
  // Called by the "clean" button, and automatically when a new file is
  // dropped onto the page while results are showing. Explicitly wipes
  // every mutable editor field so no stale data lingers — even if a
  // CSS rule somewhere fights [hidden].
  function cleanState() {
    fileInput.value = '';
    setFile(null);
    showEditor(false);
    resetBtn.hidden = true;
    copyBtn.hidden = true;
    downloadOneBtn.hidden = true;
    resetExplorer();
    clearLogs();
    consoleClear.hidden = true;
    setStatus('idle', 'idle');
    lastResult = null;
    activeModule = null;

    // explicit editor wipe
    if (codeBody) {
      codeBody.textContent = '';
      codeBody.className = 'language-javascript';
      // remove any prism line-number rows the plugin injected
      const lns = document.getElementById('code')?.querySelector('.line-numbers-rows');
      if (lns) lns.remove();
    }
    if (bundleType)    bundleType.textContent    = '—';
    if (moduleCount)   moduleCount.textContent   = '—';
    if (statOriginal)  statOriginal.textContent  = '—';
    if (statDeob)      statDeob.textContent      = '—';
    if (statReduction) statReduction.textContent = '—';
    if (statWarn)      statWarn.textContent      = '—';
    if (dcCode)        dcCode.textContent        = '—';
    if (dcHint)        dcHint.textContent        = '—';
    if (wasmBody)      wasmBody.innerHTML        = '—';
    if (wasmHint)      wasmHint.textContent      = '—';
  }

  resetBtn.addEventListener('click', cleanState);

  // ---- page-wide drag & drop -------------------------------
  // Drop a file anywhere on the page. If we're already showing
  // results, auto-clean first so the user lands on the run button.
  let dragTimer = null;
  function pageDragOn() {
    document.body.classList.add('is-page-dragging');
    clearTimeout(dragTimer);
    dragTimer = setTimeout(pageDragOff, 120);
  }
  function pageDragOff() {
    document.body.classList.remove('is-page-dragging');
  }

  document.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    pageDragOn();
  });
  document.addEventListener('dragleave', () => {
    /* timer-driven; nothing to do */
  });
  document.addEventListener('drop', (e) => {
    if (!e.dataTransfer) return;
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    e.preventDefault();
    pageDragOff();
    if (lastResult) cleanState();
    setFile(f);
    // also clear the inner drop-zone hover state if it was active
    drop.classList.remove('is-dragging');
  });

  // ---- copy / save .js for the active module ----
  function flashOk(btn, label = 'done') {
    const text = btn.querySelector('span:last-child') || btn;
    const original = text.textContent;
    text.textContent = label;
    btn.classList.add('is-ok');
    setTimeout(() => {
      text.textContent = original;
      btn.classList.remove('is-ok');
    }, 1200);
  }

  copyBtn?.addEventListener('click', async () => {
    if (!activeModule || !lastResult?.modules?.[activeModule]) return;
    const src = lastResult.modules[activeModule];
    try {
      await navigator.clipboard.writeText(src);
      flashOk(copyBtn, 'copied');
    } catch {
      // fallback: textarea + execCommand
      const ta = document.createElement('textarea');
      ta.value = src; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); flashOk(copyBtn, 'copied'); }
      catch { flashOk(copyBtn, 'failed'); }
      document.body.removeChild(ta);
    }
  });

  downloadOneBtn?.addEventListener('click', () => {
    if (!activeModule || !lastResult?.modules?.[activeModule]) return;
    const blob = new Blob([lastResult.modules[activeModule]], {
      type: 'application/javascript;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeModule}.js`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    flashOk(downloadOneBtn, 'saved');
  });

  // ---- Render ---------------------------------------------
  function renderResults(data) {
    bundleType.textContent  = data.bundleType || 'unknown';
    bundleHint.textContent  = data.bundleType || '—';
    moduleCount.textContent = String(data.moduleOrder?.length || 0);

    statOriginal.textContent  = formatBytes(data.stats?.original);
    statDeob.textContent      = formatBytes(data.stats?.deobfuscated);
    statReduction.textContent = data.stats?.reductionPercent || '—';
    statWarn.textContent      = String(data.warnings ?? 0);

    // Explorer (file list) — sorted alphabetically for predictability
    tabs.innerHTML = '';
    const sourceOrder = data.moduleOrder || Object.keys(data.modules || {});
    const order = [...sourceOrder].sort((a, b) =>
      a.localeCompare(b, 'en', { sensitivity: 'base' }),
    );
    order.forEach((name, i) => {
      const code = data.modules[name] ?? '';
      const btn = document.createElement('button');
      btn.className = 'tab' + (i === 0 ? ' is-active' : '');
      btn.dataset.module = name;
      btn.innerHTML = `<span class="tab__name">${name}.js</span><span class="tab__size">${formatBytes(code.length)}</span>`;
      btn.addEventListener('click', () => selectModule(name));
      tabs.appendChild(btn);
    });

    if (order.length) selectModule(order[0]);

    // Dynamic challenge — same Prism palette as the editor
    if (data.dynamic_challenge) {
      dcCode.textContent = data.dynamic_challenge;
      dcCode.className = 'language-javascript';
      dcHint.textContent = `${data.dynamic_challenge.length} chars`;
      // small expression — always safe to highlight
      if (typeof Prism !== 'undefined' && Prism.languages?.javascript) {
        try { Prism.highlightElement(dcCode); } catch {}
      }
    } else {
      dcCode.textContent = '— not found —';
      dcCode.className = '';
      dcHint.textContent = 'n/a';
    }

    // WASM
    wasmBody.innerHTML = '';
    if (data.wasm) {
      const w = data.wasm;
      const rows = [
        ['wasm bytes',   w.wasmBytes ? formatBytes(w.wasmBytes) : '—'],
        ['helpers',      w.helperCount ?? '—'],
        ['provider',     w.providerName || '—'],
        ['window attrs', (w.windowAttributes || []).join(', ') || '—'],
        ['fields',       (w.fields || []).join(', ') || '—'],
      ];
      rows.forEach(([k, v]) => {
        const dk = document.createElement('div');
        dk.className = 'k';
        dk.textContent = k;
        const dv = document.createElement('div');
        dv.className = 'v';
        dv.textContent = v;
        wasmBody.appendChild(dk);
        wasmBody.appendChild(dv);
      });
      wasmHint.textContent = w.wasmBytes ? formatBytes(w.wasmBytes) : 'metadata';
    } else {
      wasmBody.innerHTML = '<div class="k">status</div><div class="v">— not found —</div>';
      wasmHint.textContent = 'n/a';
    }
  }

  // Highlight only when it's worth it — Prism is synchronous; on a 400KB
  // module it would freeze the UI for ~500ms. Skip past the threshold.
  const HIGHLIGHT_MAX_BYTES = 250_000;

  function highlightCode() {
    if (typeof Prism === 'undefined' || !Prism.languages?.javascript) return;
    if ((codeBody.textContent || '').length > HIGHLIGHT_MAX_BYTES) {
      codeBody.classList.remove('language-javascript');
      return;
    }
    codeBody.classList.add('language-javascript');
    try { Prism.highlightElement(codeBody); } catch (e) { /* never break the UI for highlight */ }
  }

  function selectModule(name) {
    if (!lastResult || !lastResult.modules || !(name in lastResult.modules)) return;
    activeModule = name;
    [...tabs.children].forEach((btn) => {
      if (btn.classList && btn.dataset && btn.dataset.module !== undefined) {
        btn.classList.toggle('is-active', btn.dataset.module === name);
      }
    });
    // textContent preserves whitespace inside <pre><code>; highlightElement reads it back
    codeBody.textContent = lastResult.modules[name];
    // yield a frame so the size change paints first, then highlight
    requestAnimationFrame(highlightCode);
    // reset code panel scroll to top on tab switch
    document.getElementById('code').scrollTop = 0;
  }

  // ---- Download zip ---------------------------------------
  downloadBtn.addEventListener('click', async () => {
    if (!lastResult || !lastResult.modules) return;
    if (typeof JSZip === 'undefined') {
      setStatus('error', 'jszip unavailable');
      return;
    }
    const zip = new JSZip();
    for (const [name, code] of Object.entries(lastResult.modules)) {
      zip.file(`${name}.js`, code);
    }
    const meta = {
      bundleType: lastResult.bundleType,
      stats: lastResult.stats,
      dynamic_challenge: lastResult.dynamic_challenge,
      wasm: lastResult.wasm,
    };
    zip.file('report.json', JSON.stringify(meta, null, 2));
    // ship the run logs alongside the modules — text + json
    if (logBuffer.length) {
      zip.file('logs.txt',  logsAsText() + '\n');
      zip.file('logs.json', JSON.stringify(logBuffer, null, 2));
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `${lastResult.bundleType || 'bundle'}-deob-${stamp}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // ---- TakionAPI promo (floating bottom-right pill) -------
  // Mirrors the akamai-v3-tools pattern: minimizable, state persisted
  // in localStorage, click body to open, X to collapse.
  const promo      = $('promo');
  const promoClose = $('promoClose');
  const PROMO_KEY  = 'takionPromoMin';

  function setPromoMin(min) {
    if (!promo) return;
    promo.classList.toggle('is-min', !!min);
    promo.setAttribute(
      'aria-label',
      min ? 'TakionAPI — click to expand' : 'TakionAPI · DataDome solver, click to open',
    );
    try { localStorage.setItem(PROMO_KEY, min ? '1' : '0'); } catch {}
  }

  if (promo) {
    let saved = null;
    try { saved = localStorage.getItem(PROMO_KEY); } catch {}
    setPromoMin(saved === '1');

    // when minimized, the whole pill becomes an "expand" button
    promo.addEventListener('click', (e) => {
      if (promo.classList.contains('is-min')) {
        e.preventDefault();
        setPromoMin(false);
      }
      // otherwise: default link behaviour navigates to takionapi.tech
    });

    if (promoClose) {
      promoClose.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setPromoMin(true);
      });
    }
  }

  // ---- modal (api / npm contracts) -----------------------
  function openModal(name) {
    const m = document.getElementById(`modal${name.charAt(0).toUpperCase()}${name.slice(1)}`);
    if (!m) return;
    m.hidden = false;
    document.body.style.overflow = 'hidden';
    // highlight code blocks inside the modal on first open
    if (typeof Prism !== 'undefined') {
      m.querySelectorAll('pre code').forEach((el) => {
        try { Prism.highlightElement(el); } catch {}
      });
    }
  }
  function closeAllModals() {
    document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; });
    document.body.style.overflow = '';
  }
  document.querySelectorAll('[data-modal]').forEach((trigger) => {
    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      openModal(trigger.dataset.modal);
    });
  });
  document.querySelectorAll('[data-modal-close]').forEach((el) => {
    el.addEventListener('click', closeAllModals);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllModals();
  });

  // init
  setFile(null);
  resetExplorer();
  setStatus('idle', 'idle');
})();
