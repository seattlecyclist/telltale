# Telltale

**Client-side checkout signals for payment-fraud detection.**

**▶ Live demo: <https://seattlecyclist.github.io/telltale/>**

![Telltale dashboard: a checkout form on the left; on the right a risk panel scoring a pasted CVV as HIGH (Elevated, 30), a per-field behavioral table (dwell, tab-vs-mouse, paste ratio, re-edits), and a device-signals table showing UA family, viewport, WebGL renderer, timezone and font count.](screenshot.png)

Telltale is a small, dependency-free JavaScript library that watches *how* a checkout
form is filled and *what environment* fills it, then posts a compact signal payload to your
backend alongside the payment intent. It is a demonstration of the modern client-side
fraud-signal surface — what's worth collecting, how to collect it, and (just as important)
how to weight it without fooling yourself.

> **Status:** illustrative reference implementation. No data leaves the browser in the demo,
> and no payment is charged. Use it to understand the technique, not as a drop-in production
> risk engine.

---

## Goals

1. **Show the signal surface that still works.** The human-vs-script gap has narrowed —
   browser autofill, password managers and digital wallets compress *legitimate* flows into
   milliseconds, while stealth automation (puppeteer-extra and friends) emulates human input.
   Telltale collects the signals that remain useful in that world.

2. **Make consistency the headline, not speed.** The strongest signal is rarely "this was
   fast." It's **internal contradiction**: a request claiming iPhone Safari that renders at a
   desktop viewport, reports no touch support, and exposes an `ANGLE (Intel…)` WebGL renderer
   is spoofed *regardless* of how human the typing looked. Telltale scores these
   contradictions high and scores raw timing low, with an explicit caveat attached.

3. **Stay honest about what the client can claim.** Everything collected here is
   attacker-controllable. Telltale emits a `clientRiskHint`, never a verdict. The server owns
   the accept/decline decision and must re-derive anything security-relevant server-side.

4. **Respect privacy law by construction.** Device fingerprinting is gated behind explicit
   consent (GDPR / ePrivacy); behavioral timing strictly necessary for fraud prevention is
   collected under legitimate interest. The two are cleanly separated in the code.

---

## Signals collected

### Behavioral — *how* the form was filled
| Signal | What it captures | Why it matters |
|---|---|---|
| Dwell time per field | focus → blur duration | Scripts spend ~0ms "reading" a field |
| Paste-vs-type ratio | pasted chars vs keystrokes | Distinguishes typing from autofill/injection |
| Field re-edit patterns | re-focus & post-blur corrections | Humans backtrack and fix typos; scripts don't |
| Tab-vs-mouse navigation | how each field was entered | Pure-Tab or programmatic entry is bot-like |
| **CVV input speed / method** | keystroke cadence; pasted? | **Humans almost never paste a CVV — scripts do** |

### Device — *what* environment filled it
| Signal | Surface |
|---|---|
| WebGL renderer | `UNMASKED_RENDERER_WEBGL` (e.g. `ANGLE (Intel…)`) |
| AudioContext fingerprint | offline oscillator → compressor render hash |
| Font enumeration | OS-characteristic installed-font set |
| Timezone vs locale | `Intl` timezone vs `navigator.languages` |
| Viewport / touch vs UA | claimed device family vs actual render env |
| Automation markers | `navigator.webdriver`, Headless UA, software rasterizers |

Each signal is weighted; contradictions between *claimed* and *actual* environment dominate
the score, and timing-only signals carry a "flag, don't block" caveat.

### How the device fingerprints work

All three fingerprint surfaces are computed entirely in JavaScript, with **no permission
prompt** and no access to the camera, microphone, or files. They exploit the fact that the
same browser API produces subtly *different* output on different hardware/OS/browser
combinations, while staying *stable* on the same machine. Individually weak, together they
form a device identity — and, more usefully here, they let you catch a session whose
fingerprint contradicts its claimed user-agent.

- **WebGL renderer** — `UNMASKED_RENDERER_WEBGL` exposes the GPU/driver string, e.g.
  `ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max, …)` on a real Mac, or `ANGLE (Intel …)`
  on a Windows/Linux box. A user-agent claiming iOS Safari paired with an Intel renderer is
  the canonical spoof tell.

- **AudioContext fingerprint** — *not* the user's audio; nothing is ever played. Telltale
  renders a fixed graph offline (a 10 kHz triangle-wave oscillator → a `DynamicsCompressor`
  with fixed parameters) via `OfflineAudioContext`, then sums a slice of the output samples.
  Because that signal path is floating-point DSP, tiny differences in how each device/OS/
  browser implements the math (rounding, library versions, CPU) yield a slightly different
  number — deterministic per environment, varying across environments. The demo shows a value
  like `124.04348156`. It carries only modest entropy on its own, but it's cheap, prompt-free,
  and hard for a bot to fake *consistently* with its other claimed attributes.

- **Font enumeration** — measures the rendered width/height of a test string in candidate
  fonts; a font that isn't installed falls back to the base family, leaving dimensions
  unchanged. The *set* of detected fonts is OS-characteristic (Segoe UI ⇒ Windows, Menlo ⇒
  macOS, DejaVu/Ubuntu ⇒ Linux), so it both adds entropy and corroborates the claimed OS.

**Caveats — treat fingerprints as corroboration, never identity:**

- **Not unique.** Many identical devices share the same WebGL string, audio value, and font
  set. A fingerprint is a few bits of entropy, not a stable user ID.
- **Anti-fingerprinting defeats it.** Brave, Firefox's resist-fingerprinting, and Tor inject
  noise or pin values, so the audio number may be randomized per-session or constant. Don't
  treat a "weird" fingerprint as guilt — privacy-conscious real users look like this.
- **The signal is the *contradiction*, not the value.** A fingerprint that disagrees with the
  claimed user-agent (iOS UA + Intel GPU) is far more decisive than any single value, which is
  why Telltale weights consistency checks above the raw fingerprints.
- **Consent-gated (GDPR / ePrivacy).** These three surfaces only run after the user accepts
  the fingerprinting consent banner; decline and the device table shows `fingerprint: declined`
  and they are never collected. Behavioral timing is collected either way as strictly necessary.

---

## How to run

No build step, no dependencies — just static files.

```bash
git clone git@github.com:seattlecyclist/telltale.git
cd telltale
python3 -m http.server 8080      # any static server works
# open http://localhost:8080
```

Serving over `http://` (rather than opening `file://`) is recommended, as a few fingerprint
APIs behave differently outside an http origin.

### Try it

1. **Fill it as a human** — Tab between fields, type the CVV, go back and retype something.
   The behavioral table populates; the risk band stays **Low**.
2. **Simulate a script** — open the console and run:
   ```js
   Telltale.simulateBot()
   ```
   Values are injected with no key events and the CVV is "pasted." High-severity flags fire
   (CVV pasted, CVV set programmatically, fully pasted). Press **Pay** to see the JSON payload.
3. **Test spoof detection** — DevTools → device toolbar → emulate an iPhone → reload → Accept
   fingerprinting. Your real desktop GPU now contradicts the iOS user-agent, and the
   **GPU-vs-UA** flag fires.

Console helpers:
```js
Telltale.evaluate()   // { score, band, flags[] } for the current state
Telltale.snapshot()   // the full payload object, without pressing Pay
```

---

## Files

| File | Role |
|---|---|
| `index.html` | A checkout form + a live dashboard (behavioral table, device table, risk panel, payload) |
| `signals.js` | The collection library — behavioral listeners, device probes, consistency scoring |

---

## Backend side (not included)

In production, `signals.js` ships the payload with
`navigator.sendBeacon('/api/risk-signals', blob)` keyed to the `PaymentIntent` id. The server
should:

1. Store the raw signals against the payment attempt.
2. **Re-validate** anything security-relevant server-side (user-agent, IP geolocation vs
   claimed timezone, ASN reputation) — never trust the client's self-report.
3. Feed the features into your risk model or rules engine as **inputs**, not as a verdict.

---

## License

MIT.
