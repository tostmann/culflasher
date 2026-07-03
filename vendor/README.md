# Vendored runtime dependencies

Pinned, self-hosted copies so the flasher has **zero third-party runtime origin**.
The page holds WebUSB/WebSerial authority (it flashes firmware); a CDN/npm
compromise must not be able to reach that context. See the audit finding
`fn-cdn-vendor`.

| file | package | version | sha256 | source |
|---|---|---|---|---|
| `vue.esm-browser.prod.js` | vue | 3.5.39 | `8fc5f1a672693f8b91112155461b0f121c47ea2386b91f7de64e2b39f14241bd` | https://unpkg.com/vue@3.5.39/dist/vue.esm-browser.prod.js |
| `marked.esm.js` | marked | 18.0.5 | `43e1fc0927b2d397bdc786c0a9efa8414ce18e7781d0b3490faceea35b7d0d15` | https://cdn.jsdelivr.net/npm/marked@18.0.5/lib/marked.esm.js |
| `purify.es.mjs` | dompurify | 3.4.11 | `8a40d0a0f66c217879826a4e97bca5ef88f1b751fe813d27cf4195165aa3778f` | https://cdn.jsdelivr.net/npm/dompurify@3.4.11/dist/purify.es.mjs |

DOMPurify sanitizes the `marked` output before it reaches `v-html` (`app.js`
`parsedReadme`), so raw HTML in `README.md` (`<img onerror>`, `<script>`) cannot
execute — defense-in-depth behind the CSP.

**CSP note (`'unsafe-eval'`):** the page ships a strict CSP but its `script-src`
must include `'unsafe-eval'`. This is not optional with the current architecture:
Vue's **full** build (needed for the in-DOM template) compiles the template at
runtime via the `Function(string)` constructor — grep `Function("Vue"` in
`vue.esm-browser.prod.js`. Dropping `'unsafe-eval'` requires precompiling the
template into render functions (a build step) — tracked for a later release.
`'unsafe-eval'` does **not** permit inline `<script>` or inline event handlers,
so the injection-surface benefit of the CSP is preserved.

**To update:** download the exact pinned build, `node --check` it, byte-verify the
sha256, replace the file, bump this table, and re-test the app offline (Network
tab must show no external host). Do **not** switch Vue to the `runtime`-only
build — the app mounts an in-DOM template and needs the full (compiler) build.
