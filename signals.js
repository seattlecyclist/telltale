/*
 * Telltale — signals.js — client-side checkout signal collection (demo).
 *
 * Collects two families of signal and posts them alongside the payment intent:
 *
 *   Behavioral — how the form was filled:
 *     dwell time per field, paste-vs-type ratio, field re-edit patterns,
 *     tab-vs-mouse navigation, CVV input speed.
 *
 *   Device — what environment filled it, and whether it is internally consistent:
 *     WebGL renderer, AudioContext fingerprint, font enumeration,
 *     timezone-vs-locale, viewport-vs-claimed-device, automation markers.
 *
 * Design notes baked in from the threat model:
 *   - Raw speed is NOT decisive. Autofill, password managers and wallets compress
 *     legitimate flows into milliseconds; stealth browsers (puppeteer-extra) emulate
 *     human cadence. So timing signals are weighted low and always carry a caveat.
 *   - The strongest signals are CONSISTENCY checks: a request claiming iPhone Safari
 *     with a desktop viewport + ANGLE(Intel) WebGL renderer is spoofed regardless of
 *     how "human" the typing looked.
 *   - Device fingerprinting (WebGL/Audio/fonts) is gated behind consent for GDPR /
 *     ePrivacy. Behavioral timing is treated as strictly-necessary (legitimate interest).
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ state
  const FIELDS = ['email', 'name', 'card', 'exp', 'cvv'];
  const fieldStats = {};        // id -> behavioral stats
  let device = {};              // device signals (populated after consent)
  let consent = null;           // null = undecided, true/false once chosen
  let lastTabAt = 0;            // global: last time Tab was pressed
  let lastPointerAt = 0;        // global: last pointerdown timestamp

  FIELDS.forEach((id) => {
    fieldStats[id] = {
      dwellMs: 0,           // cumulative focus->blur time
      focusCount: 0,        // # times the field gained focus (>1 => re-edits)
      keystrokes: 0,        // printable keystrokes typed
      pastedChars: 0,       // chars introduced via paste
      firstKeyAt: 0,        // timestamp of first keystroke (for input speed)
      lastKeyAt: 0,         // timestamp of last keystroke
      enteredVia: null,     // 'tab' | 'mouse' | 'programmatic'
      changedAfterBlur: 0,  // # of edits made after the field was first left
      _focusAt: 0,
      _everBlurred: false,
    };
  });

  // -------------------------------------------------------------- behavioral
  // Global navigation-intent tracking. We can't read "was this a Tab move?"
  // directly, so we record the most recent Tab keydown / pointerdown and, on
  // focus, attribute entry to whichever happened in the last ~300ms.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') lastTabAt = performance.now();
  }, true);
  document.addEventListener('pointerdown', () => {
    lastPointerAt = performance.now();
  }, true);

  function wire(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const s = fieldStats[id];

    el.addEventListener('focus', () => {
      s.focusCount += 1;
      s._focusAt = performance.now();
      if (s.focusCount === 1) {
        const now = performance.now();
        if (now - lastTabAt < 300 && lastTabAt >= lastPointerAt) s.enteredVia = 'tab';
        else if (now - lastPointerAt < 300) s.enteredVia = 'mouse';
        else s.enteredVia = 'programmatic'; // .focus() with no input event => script
      }
    });

    el.addEventListener('blur', () => {
      if (s._focusAt) s.dwellMs += performance.now() - s._focusAt;
      s._everBlurred = true;
      render();
    });

    // Distinguish typing from pasting. A paste fires 'paste' then 'input';
    // we count the pasted length separately from keystrokes.
    el.addEventListener('paste', (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text') || '';
      s.pastedChars += text.length;
      if (s._everBlurred) s.changedAfterBlur += 1;
      render();
    });

    el.addEventListener('keydown', (e) => {
      // Count only value-producing keys (ignore Tab/Shift/Arrows/etc.)
      if (e.key.length === 1) {
        const now = performance.now();
        if (!s.firstKeyAt) s.firstKeyAt = now;
        s.lastKeyAt = now;
        s.keystrokes += 1;
        if (s._everBlurred) s.changedAfterBlur += 1;
      }
    });
  }
  FIELDS.forEach(wire);

  // --------------------------------------------------------- device signals
  function getWebGL() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return { supported: false };
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        supported: true,
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
        unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      };
    } catch (e) { return { supported: false, error: String(e) }; }
  }

  // Audio fingerprint: render a fixed oscillator->compressor graph offline and
  // sum a slice of the output. Tiny per-device floating-point differences in the
  // audio stack make this a stable surface.
  function getAudioFingerprint() {
    return new Promise((resolve) => {
      try {
        const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        if (!Ctx) return resolve(null);
        const ctx = new Ctx(1, 44100, 44100);
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = 10000;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -50; comp.knee.value = 40; comp.ratio.value = 12;
        comp.attack.value = 0; comp.release.value = 0.25;
        osc.connect(comp); comp.connect(ctx.destination);
        osc.start(0);
        ctx.oncomplete = (e) => {
          const d = e.renderedBuffer.getChannelData(0);
          let sum = 0;
          for (let i = 4500; i < 5000; i++) sum += Math.abs(d[i]);
          resolve(sum.toFixed(8));
        };
        ctx.startRendering();
      } catch (e) { resolve(null); }
    });
  }

  // Font enumeration: a font that isn't installed silently falls back to the
  // base family, so the rendered text width is unchanged. Width deltas reveal
  // which fonts are present — and the SET of fonts is OS-characteristic.
  function detectFonts() {
    const base = ['monospace', 'sans-serif', 'serif'];
    const probe = ['Arial', 'Helvetica Neue', 'Times New Roman', 'Courier New',
      'Comic Sans MS', 'Segoe UI', 'Calibri', 'Cambria', 'Tahoma',           // Windows-ish
      'San Francisco', 'Menlo', 'Monaco', 'Geneva',                          // macOS-ish
      'Roboto', 'Ubuntu', 'DejaVu Sans', 'Liberation Sans', 'Noto Sans'];    // Linux/Android-ish
    const text = 'mmmmmmmmmmlli', size = '72px';
    const span = document.createElement('span');
    span.style.cssText = 'position:absolute;left:-9999px;font-size:' + size + ';';
    span.textContent = text;
    document.body.appendChild(span);
    const baseDim = {};
    base.forEach((b) => { span.style.fontFamily = b; baseDim[b] = [span.offsetWidth, span.offsetHeight]; });
    const found = probe.filter((f) =>
      base.some((b) => {
        span.style.fontFamily = "'" + f + "'," + b;
        return span.offsetWidth !== baseDim[b][0] || span.offsetHeight !== baseDim[b][1];
      })
    );
    document.body.removeChild(span);
    return found;
  }

  function claimedFamily(ua) {
    if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
    if (/Android/i.test(ua)) return 'Android';
    if (/Windows/i.test(ua)) return 'Windows';
    if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
    if (/Linux/i.test(ua)) return 'Linux';
    return 'unknown';
  }

  async function collectDevice(withFingerprint) {
    const ua = navigator.userAgent;
    const d = {
      consentForFingerprinting: !!withFingerprint,
      userAgent: ua,
      claimedFamily: claimedFamily(ua),
      claimedMobile: /Mobi|iPhone|iPad|Android/i.test(ua),
      platform: navigator.platform || null,
      languages: navigator.languages || [navigator.language],
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timezoneOffsetMin: new Date().getTimezoneOffset(),
      viewport: { w: innerWidth, h: innerHeight },
      screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio },
      maxTouchPoints: navigator.maxTouchPoints || 0,
      touchEvents: 'ontouchstart' in window,
      // automation / headless markers
      webdriver: navigator.webdriver === true,
      headlessUA: /Headless/i.test(ua),
      pluginsCount: (navigator.plugins && navigator.plugins.length) || 0,
      hardwareConcurrency: navigator.hardwareConcurrency || null,
    };
    if (withFingerprint) {
      d.webgl = getWebGL();
      d.fonts = detectFonts();
      d.audioFingerprint = await getAudioFingerprint();
    }
    return d;
  }

  // ----------------------------------------------------- consistency scoring
  // Each rule contributes weighted points. CONSISTENCY contradictions score high;
  // pure timing scores low with an explicit caveat (autofill/wallets are legit-fast).
  function evaluate() {
    const flags = [];
    const add = (level, weight, signal, detail) => flags.push({ level, weight, signal, detail });
    const d = device;

    if (d.userAgent) {
      // --- Automation markers (strong) ---
      if (d.webdriver) add('high', 40, 'navigator.webdriver', 'Browser reports it is under automation control.');
      if (d.headlessUA) add('high', 35, 'Headless UA', 'User-agent contains "Headless".');
      if (d.consentForFingerprinting && d.webgl && d.webgl.unmaskedRenderer &&
          /SwiftShader|llvmpipe|Mesa OffScreen/i.test(d.webgl.unmaskedRenderer)) {
        add('medium', 25, 'Software renderer', 'WebGL renderer <b>' + d.webgl.unmaskedRenderer +
          '</b> is a software rasterizer — common in headless/VM environments.');
      }

      // --- Device-claim consistency (strong; this is the spoof story) ---
      if (d.claimedMobile && d.viewport.w >= 1024) {
        add('medium', 25, 'Viewport vs UA', 'UA claims a mobile device but viewport is ' +
          d.viewport.w + '×' + d.viewport.h + ' (desktop-scale).');
      }
      if (d.claimedMobile && d.maxTouchPoints === 0 && !d.touchEvents) {
        add('medium', 20, 'Touch vs UA', 'UA claims mobile but no touch support is present.');
      }
      if (d.consentForFingerprinting && d.claimedFamily === 'iOS' && d.webgl && d.webgl.unmaskedRenderer &&
          /ANGLE|Intel|NVIDIA|AMD|Mesa|llvmpipe/i.test(d.webgl.unmaskedRenderer)) {
        add('high', 40, 'GPU vs UA', 'UA claims iOS but WebGL renderer is <b>' + d.webgl.unmaskedRenderer +
          '</b>. Real iOS reports an Apple GPU — this is a spoofed user-agent.');
      }

      // --- Timezone vs locale (weak corroborating signal) ---
      const lang = (d.languages[0] || '').toLowerCase();
      if (lang.startsWith('en-us') && !/America\//.test(d.timezone)) {
        add('low', 8, 'TZ vs locale', 'Locale en-US but timezone is <b>' + d.timezone +
          '</b>. Weak on its own (travel, VPNs).');
      }
    }

    // --- Behavioral: CVV is the sharpest behavioral signal ---
    const cvv = fieldStats.cvv;
    if (cvv.pastedChars > 0) {
      add('high', 30, 'CVV pasted', 'CVV was pasted. Humans almost never paste a CVV (it is not stored); scripts do.');
    } else if (cvv.keystrokes >= 3 && cvv.firstKeyAt && (cvv.lastKeyAt - cvv.firstKeyAt) < 120) {
      add('medium', 15, 'CVV typed implausibly fast',
        Math.round(cvv.lastKeyAt - cvv.firstKeyAt) + 'ms for ' + cvv.keystrokes +
        ' digits. Suspicious, but not decisive — flag, do not block.');
    }
    if (cvv.enteredVia === 'programmatic' && (cvv.keystrokes + cvv.pastedChars) > 0) {
      add('high', 25, 'CVV set programmatically', 'CVV value changed without a focus/click/Tab event — injected by script.');
    }

    // --- Behavioral: whole-form scripted-fill heuristic (low weight, caveated) ---
    const totalKeys = FIELDS.reduce((n, f) => n + fieldStats[f].keystrokes, 0);
    const totalPaste = FIELDS.reduce((n, f) => n + fieldStats[f].pastedChars, 0);
    const anyEntry = totalKeys + totalPaste > 0;
    const noReedits = FIELDS.every((f) => fieldStats[f].changedAfterBlur === 0);
    if (anyEntry && totalKeys === 0 && totalPaste > 0) {
      add('low', 10, 'Fully pasted', 'Every field pasted, zero keystrokes. Consistent with autofill/password manager — corroborating only.');
    } else if (anyEntry && noReedits && totalKeys > 0 && totalKeys < 4) {
      add('low', 8, 'No human friction', 'No re-edits or corrections across the form. Weak; real users with autofill look like this too.');
    }

    const score = Math.min(100, flags.reduce((n, f) => n + f.weight, 0));
    const band = score >= 60 ? 'High' : score >= 25 ? 'Elevated' : 'Low';
    return { score, band, flags };
  }

  // ----------------------------------------------------------------- payload
  function buildPayload() {
    const behavioral = {};
    FIELDS.forEach((id) => {
      const s = fieldStats[id];
      const total = s.keystrokes + s.pastedChars;
      behavioral[id] = {
        dwellMs: Math.round(s.dwellMs),
        focusCount: s.focusCount,
        reEdits: Math.max(0, s.focusCount - 1),
        enteredVia: s.enteredVia,
        keystrokes: s.keystrokes,
        pastedChars: s.pastedChars,
        pasteRatio: total ? +(s.pastedChars / total).toFixed(2) : 0,
        inputSpanMs: s.firstKeyAt ? Math.round(s.lastKeyAt - s.firstKeyAt) : null,
        changedAfterBlur: s.changedAfterBlur,
      };
    });
    const verdict = evaluate();
    return {
      schemaVersion: 1,
      collectedAt: new Date().toISOString(),
      // In production: same id as the PaymentIntent so the risk engine can join them.
      paymentIntentRef: 'pi_demo_' + Math.random().toString(36).slice(2, 10),
      behavioral,
      device,
      clientRiskHint: verdict, // advisory only — server makes the real decision
    };
  }

  function post(payload) {
    // Production pattern (no-op here — there's no server):
    //   const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    //   navigator.sendBeacon('/api/risk-signals', blob);
    // or a fetch() with keepalive, fired alongside the payment confirmation.
    document.getElementById('payload').textContent = JSON.stringify(payload, null, 2);
  }

  // ------------------------------------------------------------------ render
  function navPill(via) {
    if (!via) return '<span style="color:var(--muted)">—</span>';
    const cls = via === 'tab' ? 'tab' : via === 'mouse' ? 'mouse' : 'paste';
    return '<span class="pill ' + cls + '">' + via + '</span>';
  }

  function render() {
    // behavioral table
    const rows = FIELDS.map((id) => {
      const s = fieldStats[id];
      const total = s.keystrokes + s.pastedChars;
      const pasteCell = total
        ? '<span class="pill ' + (s.pastedChars ? 'paste' : 'type') + '">' +
          Math.round((s.pastedChars / total) * 100) + '%</span>'
        : '<span style="color:var(--muted)">—</span>';
      return '<tr><td class="k">' + id + '</td><td class="v">' + Math.round(s.dwellMs) + 'ms</td>' +
        '<td>' + navPill(s.enteredVia) + '</td><td>' + pasteCell + '</td>' +
        '<td class="v">' + Math.max(0, s.focusCount - 1) + '</td></tr>';
    }).join('');
    document.getElementById('behaviorRows').innerHTML = rows;

    // device table
    const dRows = [];
    const row = (k, v) => dRows.push('<tr><td class="k">' + k + '</td><td class="v">' + v + '</td></tr>');
    if (consent === null) {
      document.getElementById('deviceRows').innerHTML =
        '<tr><td colspan="2" style="color:var(--muted)">Awaiting consent choice…</td></tr>';
    } else {
      const d = device;
      row('UA family', d.claimedFamily + (d.claimedMobile ? ' (mobile)' : ' (desktop)'));
      row('viewport', d.viewport.w + '×' + d.viewport.h + ' @ ' + d.screen.dpr + 'x');
      row('screen', d.screen.w + '×' + d.screen.h);
      row('touch', d.maxTouchPoints + ' pts / ontouchstart=' + d.touchEvents);
      row('timezone', d.timezone + ' (' + d.languages[0] + ')');
      row('webdriver', d.webdriver ? '⚠ true' : 'false');
      row('cores', d.hardwareConcurrency || '?');
      if (d.consentForFingerprinting) {
        row('WebGL', (d.webgl && d.webgl.unmaskedRenderer) || (d.webgl && d.webgl.supported ? '(masked)' : 'n/a'));
        row('audio fp', d.audioFingerprint || 'n/a');
        row('fonts', d.fonts ? d.fonts.length + ' detected' : 'n/a');
      } else {
        dRows.push('<tr><td class="k">fingerprint</td><td class="v muted-disabled">declined (consent)</td></tr>');
      }
      document.getElementById('deviceRows').innerHTML = dRows.join('');
    }

    // risk panel
    const v = evaluate();
    document.getElementById('scoreNum').textContent = v.score;
    const band = document.getElementById('scoreBand');
    band.textContent = v.band;
    band.className = 'band ' + v.band;
    const flagsEl = document.getElementById('flags');
    if (!v.flags.length) {
      flagsEl.innerHTML = '<li class="low"><span class="lvl">ok</span><span class="detail">No anomalies detected so far.</span></li>';
    } else {
      flagsEl.innerHTML = v.flags
        .sort((a, b) => b.weight - a.weight)
        .map((f) => '<li class="' + f.level + '"><span class="lvl">' + f.level +
          '</span><span class="detail"><b>' + f.signal + '</b> — ' + f.detail + '</span></li>').join('');
    }
  }

  // ------------------------------------------------------------- consent UI
  async function choose(grant) {
    consent = grant;
    document.getElementById('consent').style.display = 'none';
    device = await collectDevice(grant);
    render();
  }
  document.getElementById('consentAccept').addEventListener('click', () => choose(true));
  document.getElementById('consentDecline').addEventListener('click', () => choose(false));

  // ------------------------------------------------------------- submit flow
  document.getElementById('checkout').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (consent === null) device = await collectDevice(false); // user submitted before choosing
    const payload = buildPayload();
    post(payload);
    // (No real charge — demo only.)
  });

  // ---------------------------------------------------- bot simulation hook
  // Mimics a script: sets values via .value (no key events), pastes the CVV,
  // submits instantly. Watch the risk panel light up.
  function simulateBot() {
    const set = (id, val) => {
      const el = document.getElementById(id);
      const s = fieldStats[id];
      el.value = val;
      s.enteredVia = 'programmatic';
      s.pastedChars += val.length; // scripted assignment ~ paste, not keystrokes
      s.focusCount = Math.max(s.focusCount, 1);
    };
    if (consent === null) { consent = true; collectDevice(true).then((d) => { device = d; render(); }); }
    set('email', 'buyer9931@mail.ru');
    set('name', 'JOHN DOE');
    set('card', '4242424242424242');
    set('exp', '12/29');
    set('cvv', '123');
    render();
    console.log('[Telltale] simulated scripted fill — press Pay to see the payload.');
  }

  window.Telltale = {
    simulateBot,
    snapshot: () => buildPayload(),
    evaluate,
  };

  render();
})();
