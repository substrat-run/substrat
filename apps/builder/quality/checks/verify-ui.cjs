#!/usr/bin/env node
/*
 * verify-ui.cjs — drive a generated todo app in a headless browser, as a person would, and
 * report which of the rubric's things a person can actually do.
 *
 *   node verify-ui.cjs <run-id> [<run-id> …]
 *   node verify-ui.cjs --project <dir> --lane <N>        (or --lane-home <dir with node_modules>)
 *
 * Per build: copy the project (no node_modules, no .data), symlink node_modules from the lane
 * that built it, boot the dev issuer + API + Vite on free ports that are NOT the builds'
 * defaults, sign in through the real OIDC round trip as the owner, then try eight steps.
 * Each step is ok | fail (the control was there and used, the effect did not show) |
 * missing (no control a person could find) | blocked (an earlier step left nothing to act on).
 *
 * Controls are found by role, label and text, piercing shadow roots; nothing is a fixed selector.
 * Output dir per run: $OUT_ROOT/<label>/ (screens, serve.log, steps.log, result.json).
 *
 * Paths, all from the environment: BUILDER_RUNS (the run archive, default <repo>/data/builder-runs),
 * LANE_ROOT (the checkout whose .builder/projects/eval-<N>-todo lends node_modules, relative to the
 * repo and defaulting to it; its .builder/projects folder itself is accepted too), CHECKS_WORK
 * (default <repo>/.builder/checks), OUT_ROOT (default $CHECKS_WORK/verify-ui), PLAYWRIGHT_CORE (the
 * playwright-core package; default: resolved from here) and PLAYWRIGHT_BROWSERS_PATH (Playwright's
 * browser cache, default ~/Library/Caches/ms-playwright).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const http = require('http');

const REPO = path.resolve(__dirname, '../../../..');
const SP = process.env.CHECKS_WORK || `${REPO}/.builder/checks`;
const RUNS = `${process.env.BUILDER_RUNS || `${REPO}/data/builder-runs`}/runs`;
const LANE_ROOT = path.resolve(REPO, process.env.LANE_ROOT || '.');
const LANES = /(^|\/)\.builder\/projects\/?$/.test(LANE_ROOT) ? LANE_ROOT : `${LANE_ROOT}/.builder/projects`;
const OUT_ROOT = process.env.OUT_ROOT || `${SP}/verify-ui`;
const { chromium } = (() => {
  try {
    return require(process.env.PLAYWRIGHT_CORE || require.resolve('playwright-core'));
  } catch {
    console.error('verify-ui: no playwright-core: run `npx playwright install chromium`, then set PLAYWRIGHT_CORE to the playwright-core package directory');
    process.exit(2);
  }
})();
const FORBIDDEN_PORTS = new Set([5173, 8787, 8879, 8891, 5291]);
const STEPS = ['create', 'open', 'add', 'tick', 'delete-item', 'share', 'revoke', 'delete-list'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── arguments ─────────────────────────────

function parseArgs(argv) {
  const jobs = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') {
      const dir = argv[++i];
      let lane = null, home = null, label = path.basename(path.dirname(path.resolve(dir))) || 'project';
      while (argv[i + 1] && argv[i + 1].startsWith('--') && argv[i + 1] !== '--project') {
        const k = argv[++i];
        if (k === '--lane') lane = argv[++i];
        else if (k === '--lane-home') home = argv[++i];
        else if (k === '--label') label = argv[++i];
      }
      if (!home && lane) home = `${LANES}/eval-${lane}-todo`;
      jobs.push({ label, src: path.resolve(dir), home });
    } else {
      const m = a.match(/-l(\d+)-/);
      jobs.push({ label: a, src: `${RUNS}/${a}/project`, home: m ? `${LANES}/eval-${m[1]}-todo` : null });
    }
  }
  return jobs;
}

// ───────────────────────────── ports and processes ─────────────────────────────

function listening(port) {
  const r = cp.spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  return (r.stdout || '').trim().split('\n').slice(1).filter(Boolean);
}

function pickPorts() {
  for (let base = Number(process.env.VUI_PORT_BASE || 19300); base < 19900; base += 3) {
    const ports = [base, base + 1, base + 2];
    if (ports.some((p) => FORBIDDEN_PORTS.has(p))) continue;
    if (ports.every((p) => listening(p).length === 0)) return { iss: base, api: base + 1, web: base + 2 };
  }
  throw new Error('no free port block in 19300–19900');
}

function get(url, timeout = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => {
      req.destroy();
      resolve(0);
    });
  });
}

const procs = [];
function start(cmd, args, cwd, env, logFd) {
  const p = cp.spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', logFd, logFd] });
  procs.push(p);
  return p;
}
/** Only the process groups this script started — never anything found by name. */
async function stopAll() {
  for (const p of procs) {
    try { process.kill(-p.pid, 'SIGTERM'); } catch {}
  }
  await sleep(1200);
  for (const p of procs) {
    try { process.kill(-p.pid, 'SIGKILL'); } catch {}
  }
  procs.length = 0;
  await sleep(300);
}
function stopAllSync() {
  for (const p of procs) {
    try { process.kill(-p.pid, 'SIGKILL'); } catch {}
  }
}
process.on('exit', stopAllSync);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stopAllSync(); process.exit(130); });

// ───────────────────────────── the build ─────────────────────────────

function personas(file) {
  const s = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const m of s.matchAll(/\{[^{}]*\bsub:\s*['"`]([^'"`]+)['"`][^{}]*\}/g)) {
    const b = m[0];
    const f = (k) => (b.match(new RegExp(`\\b${k}:\\s*['"\`]([^'"\`]*)['"\`]`)) || [])[1] || '';
    out.push({ sub: m[1], name: f('name'), email: f('email'), note: f('note') });
  }
  return out;
}

function cast(ps) {
  const elsewhere = /different|other (tenant|workspace)|outsider|second tenant/i;
  const owner = ps.find((p) => /\bowner\b|\bowns\b/i.test(p.note) && !elsewhere.test(p.note)) || ps[0];
  const same = ps.filter((p) => p !== owner && !elsewhere.test(p.note));
  const target =
    same.find((p) => /shar|collab|guest|invit|member/i.test(p.note) && !/never|nothing|not shared|no shares|stranger/i.test(p.note)) ||
    same[0] || ps.find((p) => p !== owner);
  return { owner, target };
}

/** What the build reads from the environment; null when it can be moved off the defaults. */
function portBlocker(proj) {
  const server = fs.readFileSync(`${proj}/src/server.ts`, 'utf8');
  if (!/process\.env\.PORT\b/.test(server)) return 'src/server.ts does not read PORT';
  if (/8879/.test(server) && !/ISSUER_PORT|OIDC_ISSUER/.test(server)) return 'src/server.ts hard-codes the issuer port';
  return null;
}

/** A wrapper Vite config in our own copy: our port, our cache dir, the proxy re-pointed at our API. */
function writeViteWrapper(appDir) {
  const base = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs'].find((f) => fs.existsSync(`${appDir}/${f}`));
  const src = `// written by verify-ui.cjs into its own copy of the build — never into the archived run
import * as baseModule from './${base ? base.replace(/\.(m?ts|m?js)$/, '') : 'missing'}';
const API = Number(process.env.PORT);
const retarget = (t) => (typeof t === 'string' ? t.replace(/:(\\d+)(?=\\/|$)/, ':' + API) : t);
export default async (env) => {
  const b = baseModule.default;
  const c = (typeof b === 'function' ? await b(env) : await b) || {};
  const proxy = {};
  for (const [k, v] of Object.entries((c.server && c.server.proxy) || {})) {
    proxy[k] = typeof v === 'string' ? { target: retarget(v), changeOrigin: true } : { ...v, target: retarget(v.target) };
  }
  return {
    ...c,
    cacheDir: process.env.VUI_VITE_CACHE,
    clearScreen: false,
    server: { ...(c.server || {}), port: Number(process.env.WEB_PORT), strictPort: true, open: false, proxy },
  };
};
`;
  fs.writeFileSync(`${appDir}/vite.verify.config.mts`, src);
}

async function boot(job, out) {
  const proj = `${out}/project`;
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.cpSync(job.src, proj, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (s) => !/(^|\/)(node_modules|dist|\.data|\.vite)(\/|$)/.test(path.relative(job.src, s)),
  });
  if (!job.home || !fs.existsSync(`${job.home}/node_modules`)) throw new Error(`no lane install at ${job.home}`);
  fs.symlinkSync(`${job.home}/node_modules`, `${proj}/node_modules`);
  fs.symlinkSync(`${job.home}/app/node_modules`, `${proj}/app/node_modules`);
  writeViteWrapper(`${proj}/app`);

  let ports;
  const blocker = portBlocker(proj);
  if (blocker) {
    // Fall back to the defaults, but only once the other job has let go of them.
    console.log(`  ${blocker}: waiting for VERIFY_DONE and free default ports`);
    for (;;) {
      const done = fs.existsSync(`${SP}/verify-worker.log`) && fs.readFileSync(`${SP}/verify-worker.log`, 'utf8').includes('VERIFY_DONE');
      if (done && [8879, 8891, 5291].every((p) => listening(p).length === 0)) break;
      await sleep(60000);
    }
    ports = { iss: 8879, api: 8891, web: 5291 };
  } else ports = pickPorts();

  const env = {
    ...process.env,
    PORT: String(ports.api),
    WEB_PORT: String(ports.web),
    ISSUER_PORT: String(ports.iss),
    OIDC_ISSUER: `http://localhost:${ports.iss}`,
    DATA_DIR: `${out}/data`,
    VUI_VITE_CACHE: `${out}/vite-cache`,
    BROWSER: 'none',
  };
  const log = fs.openSync(`${out}/serve.log`, 'a');
  start('./node_modules/.bin/substrat-dev-issuer', ['--personas', 'src/personas.ts', '--port', String(ports.iss)], proj, env, log);
  start('./node_modules/.bin/tsx', ['src/server.ts'], proj, env, log);
  start('./node_modules/.bin/vite', ['--strictPort', '--port', String(ports.web), '--config', 'vite.verify.config.mts'], `${proj}/app`, env, log);
  const web = `http://localhost:${ports.web}`;
  const iss = `http://localhost:${ports.iss}`;
  for (let i = 0; i < 120; i++) {
    const [a, b] = await Promise.all([get(`${web}/api/me`), get(`${iss}/.well-known/openid-configuration`)]);
    if (a > 0 && a < 500 && b === 200) return { web, iss, ports, proj };
    if (procs.some((p) => p.exitCode !== null)) break;
    await sleep(500);
  }
  throw new Error('never ready through the app proxy (see serve.log)');
}

// ───────────────────────────── in-page probe ─────────────────────────────
// One function, evaluated in the page. It walks the document AND every open shadow root, treats a
// Web Awesome host (`wa-*`) as one control rather than its internals, tags what it reports with
// `data-vui` so Playwright can click it as a pointer would, and answers a few questions.

function probe(arg) {
  const W = window;
  W.__vuiN = W.__vuiN || 0;
  // An element keeps the id it was first given: a later probe (the dialog listing act() takes
  // before a click) must not re-tag a control the caller already holds. Ids carry a per-load
  // prefix, so an id from before a reload never names a different element after it.
  W.__vuiP = W.__vuiP || Math.random().toString(36).slice(2, 7);
  const tag = (el, attr) => {
    const a = attr || 'data-vui';
    const have = el.getAttribute(a);
    if (have) return have;
    const id = `${W.__vuiP}-${++W.__vuiN}`;
    el.setAttribute(a, id);
    return id;
  };
  const RX = (r) => (r ? new RegExp(r.source, r.flags) : null);
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const hostOf = (n) => {
    const r = n.getRootNode && n.getRootNode();
    return r && r instanceof ShadowRoot ? r.host : null;
  };
  const internal = (el) => {
    const h = hostOf(el);
    return !!h && /^WA-/.test(h.tagName);
  };
  const up = (el) => el.parentElement || hostOf(el);
  // A control at opacity 0 still counts: <sub-entity-table> fades a row's actions in on hover, and a
  // person with a mouse sees them there. It is reported as `faded` and hovered before the click.
  const visible = (el, anyOpacity) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    // A closed <details> keeps its content's boxes; checkVisibility knows it is not rendered.
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && (anyOpacity || Number(s.opacity) > 0.05);
  };
  function all(root, out) {
    out = out || [];
    for (const c of root.children) {
      out.push(c);
      if (c.shadowRoot) all(c.shadowRoot, out);
      all(c, out);
    }
    return out;
  }
  const deep = (a) => [a, ...(a.shadowRoot ? all(a.shadowRoot) : []), ...all(a)];
  function texts(root, out) {
    out = out || [];
    for (const n of root.childNodes) {
      if (n.nodeType === 3) {
        if (n.data.trim()) out.push(n);
      } else if (n.nodeType === 1 && !/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(n.tagName)) {
        if (n.shadowRoot) texts(n.shadowRoot, out);
        texts(n, out);
      }
    }
    return out;
  }
  const parentOf = (t) => t.parentElement || (t.parentNode && t.parentNode.host) || null;
  const shown = (t) => {
    const p = parentOf(t);
    if (!p || !visible(p)) return false;
    const rg = document.createRange();
    rg.selectNodeContents(t);
    return [...rg.getClientRects()].some((r) => r.width > 1 && r.height > 1);
  };
  function kind(el) {
    const t = el.tagName;
    const role = el.getAttribute('role');
    if (t === 'WA-INPUT' || t === 'WA-TEXTAREA') return 'textbox';
    if (t === 'INPUT') {
      const ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (['text', 'email', 'search', 'url', 'tel', ''].includes(ty)) return 'textbox';
      if (ty === 'checkbox') return 'toggle';
      if (ty === 'submit' || ty === 'button') return 'button';
      return null;
    }
    if (t === 'TEXTAREA') return 'textbox';
    if (t === 'WA-CHECKBOX' || t === 'WA-SWITCH' || role === 'checkbox' || role === 'switch') return 'toggle';
    if (t === 'WA-DROPDOWN-ITEM' || t === 'WA-MENU-ITEM' || role === 'menuitem' || role === 'menuitemcheckbox') return 'menuitem';
    if (t === 'BUTTON' || t === 'WA-BUTTON' || t === 'WA-ICON-BUTTON' || t === 'SUMMARY' || role === 'button') return 'button';
    if (t === 'A' && el.hasAttribute('href')) return 'link';
    if (el.getAttribute('contenteditable') === 'true') return 'textbox';
    return null;
  }
  function info(el, k) {
    const o = { kind: k, tag: el.tagName.toLowerCase(), id: tag(el) };
    const labs = [];
    if (el.labels) for (const l of el.labels) labs.push(norm(l.textContent));
    for (const a of ['label', 'aria-label', 'placeholder', 'title']) {
      const v = el.getAttribute(a);
      if (v) labs.push(v);
    }
    const lb = el.getAttribute('aria-labelledby');
    if (lb) for (const i of lb.split(/\s+/)) {
      const e = el.getRootNode().getElementById && el.getRootNode().getElementById(i);
      if (e) labs.push(norm(e.textContent));
    }
    const slotted = el.querySelector && el.querySelector(':scope > [slot=label]');
    if (slotted) labs.push(norm(slotted.textContent));
    if (k === 'textbox' && !/^WA-/.test(el.tagName)) {
      const wl = el.closest('label');
      if (wl) labs.push(norm(wl.textContent));
    }
    o.label = norm(labs.join(' '));
    o.name = el.getAttribute('name') || '';
    if (k === 'textbox') {
      o.type = String(el.getAttribute('type') || el.type || 'text').toLowerCase();
      o.value = String(el.value == null ? '' : el.value);
      if (/^WA-/.test(el.tagName)) {
        const inner = el.shadowRoot && el.shadowRoot.querySelector('input,textarea');
        if (inner) o.fill = tag(inner, 'data-vui-fill');
      }
    } else {
      o.type = String(el.getAttribute('type') || (el.tagName === 'BUTTON' ? el.type : '') || '').toLowerCase();
      let t = norm(el.textContent);
      if (!t) {
        const ic = el.querySelector && el.querySelector('wa-icon,[name]');
        if (ic) t = ic.getAttribute('label') || ic.getAttribute('name') || '';
      }
      if (o.label && !t.includes(o.label)) t = norm(t + ' ' + o.label);
      o.text = t;
    }
    if (k === 'toggle') o.checked = el.hasAttribute('role') && !/^(WA-|INPUT)/.test(el.tagName) ? el.getAttribute('aria-checked') === 'true' : !!el.checked;
    o.disabled = !!(el.disabled || el.getAttribute('aria-disabled') === 'true');
    const f = el.closest('form');
    if (f) {
      if (!f.getAttribute('data-vui-form')) f.setAttribute('data-vui-form', `${W.__vuiP}-${++W.__vuiN}`);
      o.form = f.getAttribute('data-vui-form');
    }
    const r = el.getBoundingClientRect();
    o.rect = { x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height };
    o.href = el.getAttribute('href') || '';
    let inDialog = false;
    for (let a = el, i = 0; a && i < 40; a = up(a), i++) if (/^(WA-DIALOG|DIALOG|WA-DRAWER)$/.test(a.tagName) || /dialog/.test(a.getAttribute('role') || '')) inDialog = true;
    o.inDialog = inDialog;
    o.faded = Number(getComputedStyle(el).opacity) <= 0.05;
    return o;
  }
  const controlsIn = (els) => els.filter((e) => !internal(e) && kind(e) && visible(e, true)).map((e) => info(e, kind(e)));
  const matches = (o, inc, exc) => {
    const s = o.kind === 'textbox' ? o.label + ' ' + o.name : o.text;
    return (!inc || inc.test(s)) && (!exc || !exc.test(s));
  };
  const hits = (needle) => texts(document.body).filter((t) => t.data.includes(needle) && shown(t));
  const STOP = (a) => /^(MAIN|BODY|HTML)$/.test(a.tagName) || a.getAttribute('role') === 'main';

  /** The smallest ancestor-or-self of the needle's text that holds a control we want. */
  function near(needle, kinds, inc, exc) {
    let best = null;
    for (const t of hits(needle)) {
      let a = parentOf(t);
      for (let depth = 0; a && depth < 14 && !STOP(a); depth++, a = up(a)) {
        const found = controlsIn(deep(a)).filter((o) => kinds.includes(o.kind) && matches(o, inc, exc));
        if (found.length) {
          if (!best || depth < best.depth) best = { depth, container: a.tagName.toLowerCase(), controls: found };
          break;
        }
      }
    }
    return best;
  }

  const op = arg.op;
  if (op === 'scan') return controlsIn(all(document.body));
  if (op === 'count') {
    const h = hits(arg.needle);
    const heading = h.some((t) => {
      for (let a = parentOf(t), i = 0; a && i < 6; a = up(a), i++) if (/^H[1-3]$/.test(a.tagName) || a.getAttribute('role') === 'heading') return true;
      return false;
    });
    return { n: h.length, heading };
  }
  if (op === 'near') return near(arg.needle, arg.kinds, RX(arg.inc), RX(arg.exc));
  if (op === 'textTarget') {
    const t = hits(arg.needle)[0];
    if (!t) return null;
    const p = parentOf(t);
    let inTable = false, pointer = false, rowClick = false;
    W.__vuiHost = null;
    for (let a = p, i = 0; a && i < 8 && !STOP(a); a = up(a), i++) {
      if (/^(TD|TR|TH)$/.test(a.tagName) || a.getAttribute('role') === 'row') inTable = true;
      if (getComputedStyle(a).cursor === 'pointer') pointer = true;
      if (/-TABLE$/.test(a.tagName) && a.tagName.includes('-')) {
        W.__vuiHost = a;
        rowClick = a.hasAttribute('row-click');
      }
    }
    return { id: tag(p), kind: 'text', text: arg.needle, inTable, pointer, rowClick, host: !!W.__vuiHost };
  }
  if (op === 'tickState') {
    const TOG = /tick|done|complete|check|mark|finish|undo|untick|reopen|✓|✔|☐|☑/i;
    for (const t of hits(arg.needle)) {
      let a = parentOf(t);
      for (let depth = 0; a && depth < 14 && !STOP(a); depth++, a = up(a)) {
        const cs = controlsIn(deep(a));
        const toggles = cs.filter((o) => o.kind === 'toggle' && !/^select\b/i.test(o.text || o.label));
        const buttons = cs.filter((o) => (o.kind === 'button' || o.kind === 'menuitem') && TOG.test(o.text) && !/delete|remove/i.test(o.text));
        if (toggles.length || buttons.length) {
          let strike = false;
          let cls = '';
          for (let b = parentOf(t), i = 0; b && i <= depth + 1; b = up(b), i++) {
            if (/^(S|DEL|STRIKE)$/.test(b.tagName) || getComputedStyle(b).textDecorationLine.includes('line-through')) strike = true;
            cls += ' ' + (b.getAttribute('class') || '') + ' ' + (b.getAttribute('data-done') != null ? 'data-done=' + b.getAttribute('data-done') : '');
          }
          return {
            toggles: toggles.map((o) => o.checked),
            buttons: buttons.map((o) => o.text),
            strike,
            doneClass: /\b(done|completed|checked|ticked|is-done)\b|data-done=(1|true)/.test(cls),
            // Text nodes joined with spaces: textContent runs cells together ("Milkdone").
            rowText: norm(texts(a).map((x) => x.data).join(' ')).slice(0, 300),
          };
        }
      }
    }
    return null;
  }
  if (op === 'dialogs') {
    const out = [];
    for (const d of all(document.body)) {
      const isDlg = /^(WA-DIALOG|WA-DRAWER)$/.test(d.tagName) ? d.hasAttribute('open') : d.tagName === 'DIALOG' ? d.open : /^(dialog|alertdialog)$/.test(d.getAttribute('role') || '') && visible(d);
      if (!isDlg || internal(d)) continue;
      if (!d.getAttribute('data-vui-dlg')) d.setAttribute('data-vui-dlg', `${W.__vuiP}-${++W.__vuiN}`);
      out.push({ dlg: d.getAttribute('data-vui-dlg'), controls: controlsIn(deep(d).slice(1)) });
    }
    return out;
  }
  if (op === 'url') return location.href;
  return null;
}

// ───────────────────────────── the person ─────────────────────────────

class Person {
  constructor(page, web, iss, out, log) {
    this.page = page;
    this.web = web;
    this.iss = iss;
    this.out = out;
    this.log = log;
    this.inflight = new Set();
    this.events = { dialogs: [], api: [], pageerrors: [], console: [] };
    this.answer = '';
    page.on('request', (r) => this.inflight.add(r));
    page.on('requestfinished', (r) => this.inflight.delete(r));
    page.on('requestfailed', (r) => this.inflight.delete(r));
    page.on('dialog', async (d) => {
      this.events.dialogs.push(`${d.type()}: ${d.message().slice(0, 120)}`);
      try {
        if (d.type() === 'prompt') await d.accept(this.answer || d.defaultValue());
        else await d.accept();
      } catch {}
    });
    page.on('response', (r) => {
      if (r.status() >= 400 && r.url().startsWith(web + '/api/')) this.events.api.push(`${r.status()} ${r.request().method()} ${r.url().slice(web.length)}`);
    });
    page.on('pageerror', (e) => this.events.pageerrors.push(String(e).slice(0, 200)));
    page.on('console', (m) => {
      if (m.type() === 'error') this.events.console.push(m.text().slice(0, 200));
    });
  }
  q(arg) {
    return this.page.evaluate(probe, arg);
  }
  scan() {
    return this.q({ op: 'scan' });
  }
  count(needle) {
    return this.q({ op: 'count', needle });
  }
  near(needle, kinds, inc, exc) {
    const r = (x) => (x ? { source: x.source, flags: x.flags } : null);
    return this.q({ op: 'near', needle, kinds, inc: r(inc), exc: r(exc) });
  }
  loc(c) {
    return this.page.locator(c.fill ? `[data-vui-fill="${c.fill}"]` : `[data-vui="${c.id}"]`).first();
  }
  async click(c) {
    const l = this.loc(c);
    if (c.faded) {
      await l.hover({ timeout: 4000 }).catch(() => {});
      await sleep(250);
    }
    await l.click({ timeout: 6000 });
  }
  async settle(ms = 400) {
    await sleep(ms);
    await this.page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
    const t0 = Date.now();
    let quiet = 0;
    while (Date.now() - t0 < 7000) {
      if (this.inflight.size === 0) {
        quiet += 100;
        if (quiet >= 400) break;
      } else quiet = 0;
      await sleep(100);
    }
  }
  async until(fn, ms = 6000) {
    const t0 = Date.now();
    for (;;) {
      let v;
      try {
        v = await fn();
      } catch {
        v = null;
      }
      if (v) return v;
      if (Date.now() - t0 > ms) return null;
      await sleep(250);
    }
  }
  async reload() {
    await this.page.reload({ waitUntil: 'load' }).catch(() => {});
    await this.settle(600);
    if (this.afterReload) await this.afterReload();
  }
  async shot(name) {
    const f = path.join(this.out, `${name}.png`);
    await this.page.screenshot({ path: f, fullPage: true }).catch(() => {});
    return f;
  }
}

// ── what a control is for ──

const desc = (c) => `${c.label} ${c.name}`.toLowerCase();

function submitFor(inp, ctrls, rx) {
  const btns = ctrls.filter((c) => c.kind === 'button' && !c.disabled && c !== inp);
  if (inp.form) {
    const inForm = btns.filter((b) => b.form === inp.form);
    const b = inForm.find((x) => x.type === 'submit') || (rx && inForm.find((x) => rx.test(x.text))) || (inForm.length === 1 ? inForm[0] : null);
    if (b) return b;
  }
  const cx = inp.rect.x + inp.rect.w / 2, cy = inp.rect.y + inp.rect.h / 2;
  const cand = btns
    .filter((b) => !rx || rx.test(b.text))
    .map((b) => ({ b, d: Math.hypot(b.rect.x + b.rect.w / 2 - cx, b.rect.y + b.rect.h / 2 - cy) }))
    .filter((x) => x.d < 420)
    .sort((a, b) => a.d - b.d);
  return cand.length ? cand[0].b : null;
}

function listInputScore(c, ctrls) {
  if (c.kind !== 'textbox' || c.type === 'email' || c.type === 'search') return -1;
  const d = desc(c);
  let s = 0;
  if (/\blists?\b/.test(d)) s += 3;
  if (/new|create|add|name|title/.test(d)) s += 1;
  if (/^(name|title|listname|list_name|list-name)$/i.test(c.name)) s += 2;
  if (/\bitem|task|e-?mail|search|filter|rename|invite|share/.test(d) || /todo(?! ?list)/.test(d)) s -= 10;
  if (c.value) s -= 10;
  const b = submitFor(c, ctrls);
  if (b && /create|new|add|make|save|\+/i.test(b.text)) s += 2;
  return s;
}

function itemInputScore(c, ctrls) {
  if (c.kind !== 'textbox' || c.type === 'email' || c.type === 'search') return -1;
  const d = desc(c);
  let s = 0;
  if (/item|todo|to-do|task|thing|entry/.test(d)) s += 4;
  else if (/\blists?\b/.test(d)) s -= 10;
  if (/add|new/.test(d)) s += 1;
  if (/^(text|item|title|label|content|description|body)$/i.test(c.name)) s += 2;
  if (/e-?mail|rename|search|filter|invite|share/.test(d)) s -= 10;
  if (c.value) s -= 10;
  const b = submitFor(c, ctrls);
  if (b && /^\s*(add|\+)/i.test(b.text)) s += 2;
  if (b && /rename|share|invite/i.test(b.text)) s -= 3;
  return s;
}

function emailInputScore(c) {
  if (c.kind !== 'textbox' || c.type === 'search') return -1;
  const d = desc(c);
  let s = 0;
  if (c.type === 'email') s += 5;
  if (/e-?mail|address|invite|share|collaborat|person|people/.test(d)) s += 4;
  if (/search|filter|rename|item/.test(d)) s -= 10;
  if (c.value) s -= 2;
  return s;
}

const best = (ctrls, score) => {
  let top = null, sc = 0;
  for (const c of ctrls) {
    const s = score(c, ctrls);
    if (s > sc) {
      sc = s;
      top = c;
    }
  }
  return top;
};

const AFFIRM = /^\s*(delete|remove|yes|ok|okay|confirm|revoke|continue|sure|withdraw|un-?share|stop sharing|trash|move to trash|proceed)\b/i;
const NEGATE = /^\s*(cancel|no|keep|close|back|dismiss)\b/i;

async function confirmInApp(p, before) {
  await sleep(350);
  const dl = (await p.q({ op: 'dialogs' })).filter((d) => !before.includes(d.dlg));
  for (const d of dl) {
    const box = d.controls.find((c) => c.kind === 'textbox');
    if (box && p.answer) await p.loc(box).fill(p.answer).catch(() => {});
    const yes = d.controls.find((c) => (c.kind === 'button' || c.kind === 'menuitem') && AFFIRM.test(c.text) && !NEGATE.test(c.text));
    if (yes) {
      await p.click(yes);
      p.log(`    confirmed in-app dialog with "${yes.text}"`);
      return true;
    }
  }
  return false;
}

/** Click, then answer an in-app confirmation if one opened because of it. */
async function act(p, c) {
  const before = (await p.q({ op: 'dialogs' })).map((d) => d.dlg);
  await p.click(c);
  await confirmInApp(p, before);
  await p.settle();
  if (p.afterReload) await p.afterReload();
}

/** Close whatever dialog is open: Escape first, then the dialog's own close control. */
async function closeDialogs(p) {
  for (let i = 0; i < 3; i++) {
    const open = await p.q({ op: 'dialogs' });
    if (!open.length) return;
    if (i === 0) {
      await p.page.keyboard.press('Escape').catch(() => {});
    } else {
      const close = open.flatMap((d) => d.controls).find((c) => (c.kind === 'button' || c.kind === 'link') && /^\s*(close|done|cancel|dismiss|×|✕|✖)\s*$/i.test(c.text));
      if (close) await p.click(close).catch(() => {});
      else await p.page.keyboard.press('Escape').catch(() => {});
    }
    await sleep(400);
  }
}

/** A control near the needle, or one behind a "more actions" menu near it. */
async function nearOrMenu(p, needle, inc, exc) {
  const n = await p.near(needle, ['button', 'menuitem', 'link'], inc, exc);
  if (n) return { c: n.controls[0], via: n.container };
  const more = await p.near(needle, ['button'], /more|⋯|…|\.\.\.|actions|menu|options|kebab/i, /delete|remove/i);
  if (!more) return null;
  await p.click(more.controls[0]);
  await sleep(500);
  const items = (await p.scan()).filter((c) => (c.kind === 'menuitem' || c.kind === 'button') && inc.test(c.text) && !(exc && exc.test(c.text)));
  if (items.length) return { c: items[0], via: 'menu' };
  await p.page.keyboard.press('Escape').catch(() => {});
  return null;
}

async function toLists(p, home) {
  const ctrls = await p.scan();
  const nav = ctrls.find((c) => c.kind === 'link' && /^(←\s*)?(my lists|lists|all lists|your lists|home|back)\b/i.test(c.text) && !/shared/i.test(c.text));
  if (nav) await p.click(nav).catch(() => {});
  else await p.page.goto(home, { waitUntil: 'load' }).catch(() => {});
  await p.settle(500);
}

// ───────────────────────────── the flow ─────────────────────────────

async function signIn(p, persona) {
  const { page, web, iss } = p;
  await page.goto(web + '/', { waitUntil: 'load' });
  await p.settle(1500);
  if (!page.url().startsWith(iss)) {
    const signin = (await p.scan()).find((c) => (c.kind === 'button' || c.kind === 'link') && /\b(sign|log) ?in\b/i.test(c.text));
    if (signin) await p.click(signin);
    else await page.goto(web + '/api/auth/login');
  }
  await page.waitForURL((u) => u.toString().startsWith(iss), { timeout: 12000 }).catch(() => {});
  if (!page.url().startsWith(iss)) return `never reached the issuer (at ${page.url()})`;
  const pick = page.locator(`a[href*="sub=${encodeURIComponent(persona.sub)}"]`);
  if (await pick.count()) await pick.first().click();
  else await page.getByText(persona.name, { exact: false }).first().click();
  await page.waitForURL((u) => u.toString().startsWith(web), { timeout: 15000 }).catch(() => {});
  await p.settle(1200);
  const me = await page.evaluate(() => fetch('/api/me').then((r) => r.status).catch(() => 0));
  if (me !== 200) return `back at ${page.url()}, /api/me answers ${me}`;
  return null;
}

async function run(job) {
  const out = `${OUT_ROOT}/${job.label}`;
  const lines = [];
  const log = (s) => {
    lines.push(s);
    console.log(s);
  };
  const result = Object.fromEntries(STEPS.map((s) => [s, { status: 'blocked', reason: 'not reached' }]));
  let env, browser, reached = 'person';
  const extra = {};
  try {
    log(`== ${job.label}`);
    env = await boot(job, out);
    log(`  up: issuer :${env.ports.iss}  api :${env.ports.api}  web :${env.ports.web}`);
    const ps = personas(`${env.proj}/src/personas.ts`);
    const { owner, target } = cast(ps);
    log(`  owner ${owner.name} <${owner.email}>, shares with ${target.name} <${target.email}>`);
    const exe = findBrowser();
    browser = await chromium.launch({ executablePath: exe });
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 860 } });
    const page = await ctx.newPage();
    const p = new Person(page, env.web, env.iss, out, log);

    const why = await signIn(p, owner);
    if (why) {
      extra.signin = why;
      log(`  SIGN-IN FAILED: ${why}`);
      await p.shot('0-signin-failed');
      for (const s of STEPS) result[s] = { status: 'blocked', reason: 'sign-in failed: ' + why };
      return finish();
    }
    const home = page.url();
    log(`  signed in, at ${home}`);
    await p.shot('0-signed-in');

    const tagN = String(Date.now()).slice(-4);
    const LIST = `Errands ${tagN}`;
    const ITEM = `Buy milk ${tagN}`;
    let firstShot = false;
    let openMode = null;
    let listsUrl = home;
    let staleCreate = false, staleAdd = false;
    const step = async (name, fn) => {
      const mark = { d: p.events.dialogs.length, a: p.events.api.length, e: p.events.pageerrors.length };
      let r;
      try {
        r = await fn();
      } catch (e) {
        r = { status: 'fail', reason: 'threw: ' + String(e.message || e).split('\n')[0].slice(0, 160) };
      }
      const said = p.events.dialogs.slice(mark.d).filter((d) => d.startsWith('alert'));
      const api = p.events.api.slice(mark.a);
      if (r.status !== 'ok' && said.length) r.reason += ` | ${said.join(' / ')}`;
      if (r.status !== 'ok' && api.length) r.reason += ` | api: ${[...new Set(api)].slice(0, 4).join(', ')}`;
      const errs = p.events.pageerrors.slice(mark.e);
      if (errs.length) r.reason = (r.reason ? r.reason + ' | ' : '') + `pageerror: ${errs[0]}`;
      result[name] = r;
      if (r.status !== 'ok' && r.status !== 'blocked') {
        r.screenshot = await p.shot(`${firstShot ? '' : 'FIRST-'}${name}-${r.status}`);
        firstShot = true;
      }
      log(`  ${r.status === 'ok' ? 'OK  ' : r.status.toUpperCase().padEnd(4)} ${name}${r.reason ? ' — ' + r.reason : ''}`);
      return r.status === 'ok';
    };
    const ok = (reason = '') => ({ status: 'ok', reason });
    const fail = (reason) => ({ status: 'fail', reason });
    const missing = (reason) => ({ status: 'missing', reason });

    // 1. create a list
    const created = await step('create', async () => {
      p.answer = LIST;
      let ctrls = await p.scan();
      let inp = best(ctrls, listInputScore);
      if (!inp) {
        // a nav link to the lists screen, then a "New list" button that reveals the form
        const nav = ctrls.find((c) => c.kind === 'link' && /^(my lists|lists|all lists|your lists)$/i.test(c.text));
        if (nav) {
          await p.click(nav);
          await p.settle();
          ctrls = await p.scan();
          inp = best(ctrls, listInputScore);
        }
      }
      if (!inp) {
        const reveal = ctrls.find((c) => (c.kind === 'button' || c.kind === 'link') && /^\s*(\+\s*)?(new|create|add)( a)?( new)? list\b|^\s*\+\s*$|^\s*new\s*$/i.test(c.text));
        if (reveal) {
          const before = (await p.count(LIST)).n;
          await p.click(reveal);
          await p.settle();
          if ((await p.count(LIST)).n > before) return ok(`via "${reveal.text}" and a prompt`);
          ctrls = await p.scan();
          inp = best(ctrls, listInputScore);
          if (!inp) inp = best(ctrls, (c) => (c.kind === 'textbox' && c.type !== 'email' && !c.value ? 1 : 0));
        }
      }
      if (!inp) {
        const join = ctrls.find((c) => c.kind === 'button' && /^\s*(join|get started|continue|set up|create (my )?account|enter)\b/i.test(c.text));
        if (join) {
          await act(p, join);
          ctrls = await p.scan();
          inp = best(ctrls, listInputScore);
          if (inp) p.log(`    joined first with "${join.text}"`);
        }
      }
      if (!inp) return missing('no field to name a new list');
      await p.loc(inp).fill(LIST);
      const sub = submitFor(inp, await p.scan(), /create|new|add|make|save|\+/i);
      if (sub) await act(p, sub);
      else {
        await p.loc(inp).press('Enter');
        await p.settle();
      }
      const seen = await p.until(async () => (await p.count(LIST)).n > 0);
      if (!seen) {
        const did = `filled "${inp.label || inp.name}" and ${sub ? `pressed "${sub.text}"` : 'pressed Enter'}`;
        await p.reload();
        if (await p.until(async () => (await p.count(LIST)).n > 0, 4000)) {
          listsUrl = page.url();
          staleCreate = true;
          return fail(`${did}; the list was created but shows only after a reload (the screen does not redraw it)`);
        }
        return fail(`${did}; the list never showed, not even after a reload`);
      }
      listsUrl = page.url();
      return ok(`"${inp.label || inp.name}" + ${sub ? `"${sub.text}"` : 'Enter'}`);
    });
    if (!created && !staleCreate) return finish();
    if (staleCreate) log('    (went on with the list as a person would after reloading)');

    // 2. open it
    const itemInputHere = async () => best(await p.scan(), itemInputScore);
    const opened = await step('open', async () => {
      const before = { url: page.url(), input: !!(await itemInputHere()) };
      const ctrls = await p.scan();
      // A row action names its row ("Delete Errands 12"): it is never how a person opens the list.
      const ACTS = /^\s*(delete|remove|rename|archive|share|leave|revoke)\b/i;
      let target = ctrls.find((c) => c.kind === 'link' && c.text.includes(LIST)) || ctrls.find((c) => c.kind === 'button' && c.text.includes(LIST) && !ACTS.test(c.text));
      let how = target ? `${target.kind} "${target.text.slice(0, 40)}"` : '';
      let looksClickable = !!target;
      if (!target) {
        const n = await p.near(LIST, ['button', 'link'], /^\s*(open|view|show|details|manage|go)\b|→|›|»/i, /delete|remove|rename/i);
        if (n) {
          target = n.controls[0];
          how = `"${target.text}" beside it`;
          looksClickable = true;
        }
      }
      if (!target) {
        target = await p.q({ op: 'textTarget', needle: LIST });
        if (!target) return fail('the list name is not on screen');
        // Plain text is only a control if the app made it one: a pointer cursor, a table told to
        // answer row clicks (`row-click`), or the app listening for a row-click event on the table.
        // A table nobody wired is a missing control, not a broken one.
        const rowListeners = target.host ? await hostListeners(page) : [];
        looksClickable = target.pointer || target.rowClick || rowListeners.length > 0;
        how =
          `its name as plain text${target.inTable ? ' in a table row' : ''}${target.pointer ? ' (pointer cursor)' : ''}` +
          (target.rowClick ? ' (table has row-click)' : '') +
          (rowListeners.length ? ` (app listens for ${rowListeners.join(', ')} on the table)` : target.inTable ? ' (no row-click wired on the table)' : '');
      }
      await p.click(target);
      await p.settle(600);
      const opened = await p.until(async () => page.url() !== before.url || (!before.input && !!(await itemInputHere())), 4000);
      if (opened) {
        openMode = page.url() !== before.url ? 'url' : 'inplace';
        return ok(`clicked ${how}${openMode === 'inplace' ? ' (opens in place)' : ''}`);
      }
      return looksClickable ? fail(`clicked ${how}; nothing opened`) : missing(`the name is not a link and nothing beside it opens the list (clicked ${how}, nothing happened)`);
    });
    if (!opened) {
      // Not something a person could do; done only so the remaining steps still say something.
      const link = await deepLink(p, env.proj, LIST, itemInputHere);
      if (link) {
        reached = 'deeplink';
        log(`    reached the list by deep link ${link} to judge the rest`);
      } else {
        log('    no deep link reached the list screen either');
        for (const s of ['add', 'tick', 'delete-item', 'share', 'revoke']) result[s] = { status: 'blocked', reason: 'the list could not be opened, by a person or by a deep link' };
      }
    }
    const onList = opened || reached === 'deeplink';
    const listUrl = page.url();
    // An app that reloads after every change closes a list that opened in place (a <details>,
    // a panel); a person opens it again to see what they did. A URL-routed list stays open.
    const ensureOpen = async () => {
      if (!onList) return;
      if (page.url() !== listUrl) {
        await page.goto(listUrl).catch(() => {});
        await p.settle(500);
      }
      if (openMode !== 'inplace' || (await itemInputHere())) return;
      const ctrls = await p.scan();
      const t = ctrls.find((c) => (c.kind === 'link' || c.kind === 'button') && c.text.includes(LIST)) || (await p.q({ op: 'textTarget', needle: LIST }));
      if (!t) return;
      await p.click(t).catch(() => {});
      await p.settle(400);
      log('    (opened the list again after the page reloaded)');
    };
    p.afterReload = ensureOpen;

    // 3. add an item
    let added = false;
    if (onList) {
      added = await step('add', async () => {
        p.answer = ITEM;
        let ctrls = await p.scan();
        let inp = best(ctrls, itemInputScore);
        if (!inp) {
          const reveal = ctrls.find((c) => c.kind === 'button' && /^\s*(\+\s*)?(new|add)( an?)?( new)? (item|todo|task|entry)\b/i.test(c.text));
          if (reveal) {
            const before = (await p.count(ITEM)).n;
            await p.click(reveal);
            await p.settle();
            if ((await p.count(ITEM)).n > before) return ok(`via "${reveal.text}" and a prompt`);
            ctrls = await p.scan();
            inp = best(ctrls, itemInputScore);
          }
        }
        if (!inp) return missing('no field to write a new item');
        await p.loc(inp).fill(ITEM);
        const sub = submitFor(inp, await p.scan(), /add|\+|save|create/i);
        if (sub) await act(p, sub);
        else {
          await p.loc(inp).press('Enter');
          await p.settle();
        }
        const seen = await p.until(async () => (await p.count(ITEM)).n > 0);
        if (!seen) {
          const did = `filled "${inp.label || inp.name}" and ${sub ? `pressed "${sub.text}"` : 'pressed Enter'}`;
          await p.reload();
          if (await p.until(async () => (await p.count(ITEM)).n > 0, 4000)) {
            staleAdd = true;
            return fail(`${did}; the item was added but shows only after a reload (the screen does not redraw it)`);
          }
          return fail(`${did}; the item never showed, not even after a reload`);
        }
        return ok(`"${inp.label || inp.name}" + ${sub ? `"${sub.text}"` : 'Enter'}`);
      });
      if (!added && staleAdd) added = true;
      else if (!added) for (const s of ['tick', 'delete-item']) result[s] = { status: 'blocked', reason: 'no item to act on' };
    }

    // 4. tick it
    const ticked = (b, a) =>
      !!a &&
      (a.toggles.some((x, i) => x && !(b && b.toggles[i])) ||
        (a.strike && !(b && b.strike)) ||
        (a.doneClass && !(b && b.doneClass)) ||
        (b && a.buttons.join('|') !== b.buttons.join('|') && a.buttons.some((t) => /undo|untick|uncheck|reopen|not done|mark (as )?(open|undone|incomplete|not)|✓|✔|☑/i.test(t))) ||
        (b && a.rowText !== b.rowText && /\b(done|completed|ticked)\b|✓|✔/i.test(a.rowText) && !/\b(done|completed|ticked)\b|✓|✔/i.test(b.rowText)) ||
        // A "Done" cell: exactly one word of the row changed, from 0, no or false to 1, yes or true,
        // or a cell that showed nothing for false now says yes or true (and maybe who ticked it).
        (b && flipped(b.rowText, a.rowText)) ||
        (b && a.rowText !== b.rowText && /\b(yes|true)\b/i.test(a.rowText) && !/\b(yes|true)\b/i.test(b.rowText)));
    const flipped = (before, after) => {
      const x = before.split(/\s+/), y = after.split(/\s+/);
      if (x.length !== y.length) return false;
      const d = x.map((w, i) => [w, y[i]]).filter(([u, v]) => u !== v);
      return d.length === 1 && /^(0|no|false)$/i.test(d[0][0]) && /^(1|yes|true)$/i.test(d[0][1]);
    };
    if (added) {
      await step('tick', async () => {
        const before = await p.q({ op: 'tickState', needle: ITEM });
        let c = null;
        const tog = await p.near(ITEM, ['toggle'], null, /^\s*select\b/i);
        if (tog) c = tog.controls[0];
        if (!c) {
          const b = await p.near(ITEM, ['button', 'menuitem'], /tick|done|complete|check|mark|finish|✓|✔|☐/i, /^\s*(delete|remove|edit|rename|undo|untick|uncheck|reopen|not done|mark (as )?(not done|open|undone|incomplete))/i);
          if (b) c = b.controls[0];
        }
        if (!c) return missing('no checkbox or "done" control beside the item');
        const what = c.kind === 'toggle' ? `checkbox "${(c.text || c.label).slice(0, 30)}"` : `"${c.text}"`;
        await act(p, c);
        const now = await p.until(async () => {
          const a = await p.q({ op: 'tickState', needle: ITEM });
          return ticked(before, a) ? a : null;
        });
        if (!now) return fail(`clicked ${what}; the item does not show as done`);
        await p.reload();
        await p.until(async () => (await p.count(ITEM)).n > 0);
        const kept = await p.q({ op: 'tickState', needle: ITEM });
        if (!ticked(before, kept)) return fail(`clicked ${what}; it showed done, but not after a reload`);
        return ok(`clicked ${what}, still done after reload`);
      });

      // 5. delete the item
      await step('delete-item', async () => {
        const f = await nearOrMenu(p, ITEM, /delete|remove|trash|discard|×|✕|✖|🗑|^\s*x\s*$/i, /\blists?\b/i);
        if (!f) return missing('no delete control beside the item');
        await act(p, f.c);
        const gone = await p.until(async () => (await p.count(ITEM)).n === 0);
        if (!gone) return fail(`clicked "${f.c.text}"; the item is still there`);
        await p.reload();
        await p.until(async () => !!(await itemInputHere()), 4000);
        if ((await p.count(ITEM)).n) return fail(`clicked "${f.c.text}"; it went, and came back after a reload`);
        return ok(`"${f.c.text}"${f.c.faded ? ' (shown on hover)' : ''}`);
      });
    }

    // 6. share by email
    const revealShare = async () => {
      let ctrls = await p.scan();
      let inp = best(ctrls, emailInputScore);
      if (inp) return { inp, ctrls };
      const r = ctrls.find((c) => (c.kind === 'button' || c.kind === 'link') && /^\s*(share|invite|manage (access|sharing)|sharing|people|collaborators|members|add (people|a person|collaborators?|members?))\b|\b(shared with|who (it|this list) is shared)\b/i.test(c.text) && !/shared with (me|you)\b/i.test(c.text));
      if (!r) return { inp: null, ctrls };
      await p.click(r);
      await p.settle();
      ctrls = await p.scan();
      inp = best(ctrls, emailInputScore);
      return { inp, ctrls, revealedBy: r.text };
    };
    const mentions = async () => {
      const a = await p.count(target.email);
      const b = target.name ? await p.count(target.name) : { n: 0 };
      return { email: a.n, name: b.n };
    };
    let shared = false, base0 = null;
    if (onList) {
      await ensureOpen();
      shared = await step('share', async () => {
        p.answer = target.email;
        base0 = await mentions();
        const { inp, ctrls, revealedBy } = await revealShare();
        if (!inp) return missing('no field that takes an email address');
        await p.loc(inp).fill(target.email);
        const sub = submitFor(inp, ctrls, /share|invite|send|add|grant|give/i);
        if (sub) await act(p, sub);
        else {
          await p.loc(inp).press('Enter');
          await p.settle();
        }
        const how = `${revealedBy ? `"${revealedBy}" → ` : ''}"${inp.label || inp.name}" + ${sub ? `"${sub.text}"` : 'Enter'}`;
        const listed = async () => {
          const m = await mentions();
          return m.email > base0.email || m.name > base0.name;
        };
        if (await p.until(listed, 5000)) return ok(how);
        await revealShare();
        if (await p.until(listed, 2000)) return ok(how + ' (listed after reopening)');
        return fail(`${how}; ${target.email} is not listed afterwards`);
      });
      if (!shared) result.revoke = { status: 'blocked', reason: 'nothing shared to revoke' };
    }

    // 7. revoke it
    if (shared) {
      await step('revoke', async () => {
        // The share step may have left its dialog open over a list of shares behind it; a person
        // closes it first, and opens the share view again only when the shares are not on the page.
        await closeDialogs(p);
        const REV = /revoke|remove|cancel|withdraw|un-?share|stop sharing|uninvite|delete|trash|×|✕|✖|🗑|^\s*x\s*$/i;
        const EX = /\b(delete|remove|rename) (this )?list\b|^\s*(share|invite)\b/i;
        const find = async () => {
          let c = (await p.count(target.email)).n ? await nearOrMenu(p, target.email, REV, EX) : null;
          if (!c && target.name) c = await nearOrMenu(p, target.name, REV, EX);
          return c;
        };
        // On the page first; only then in the share view, which may be a dialog the person opens again.
        let f = await find();
        if (!f) {
          await revealShare();
          f = await find();
        }
        if (!f) return missing(`no revoke/remove control beside ${target.email}`);
        await act(p, f.c);
        const gone = async () => {
          const m = await mentions();
          return m.email <= base0.email && m.name <= base0.name;
        };
        if (!(await p.until(gone))) return fail(`clicked "${f.c.text}"; ${target.email} is still listed`);
        await p.reload();
        await revealShare();
        await sleep(500);
        if (!(await gone())) return fail(`clicked "${f.c.text}"; it went, and came back after a reload`);
        return ok(`"${f.c.text}"${f.c.faded ? ' (shown on hover)' : ''}`);
      });
    }

    // 8. delete the list
    await step('delete-list', async () => {
      p.answer = LIST;
      // The revoke step may have left the share dialog open; a person closes it before reaching
      // for anything behind it, and a modal left open would swallow the click.
      await closeDialogs(p);
      await ensureOpen();
      let c = null, where = '';
      if (onList) {
        const ctrls = (await p.scan()).filter((x) => (x.kind === 'button' || x.kind === 'menuitem') && !x.inDialog);
        c = ctrls.find((x) => /(delete|remove|trash|bin)\b.*\blists?\b|\blists?\b.*\b(delete|remove)/i.test(x.text)) || null;
        if (!c) {
          const generic = ctrls.filter((x) => /^\s*(delete|remove|trash|move to trash|delete…|🗑)\s*$/i.test(x.text));
          if (generic.length === 1) c = generic[0];
        }
        where = 'on the list';
      }
      if (!c) {
        await toLists(p, listsUrl);
        const f = await nearOrMenu(p, LIST, /delete|remove|trash|\bbin\b|×|✕|✖|🗑/i, /rename/i);
        if (f) {
          c = f.c;
          where = 'beside it in the lists';
        }
      }
      if (!c && !onList) return { status: 'blocked', reason: 'nothing beside it in the lists, and the list itself could not be opened to look there' };
      if (!c) return missing('no delete control on the list or beside it in the lists');
      p.afterReload = null;
      await act(p, c);
      // Judge it on the screen it was created on, rendered and read without errors, so a blank
      // or failed screen cannot pass for "gone".
      await page.goto(listsUrl).catch(() => {});
      const mark = p.events.api.length;
      await p.reload();
      const ready = await p.until(async () => !!best(await p.scan(), listInputScore), 5000);
      await p.settle(500);
      const errs = p.events.api.slice(mark);
      if ((await p.count(LIST)).n) return fail(`clicked "${c.text}" ${where}; the list is still in the lists`);
      if (!ready || errs.length) return fail(`clicked "${c.text}" ${where}; the lists screen did not come back cleanly to confirm it (${errs[0] || 'no create field'})`);
      return ok(`"${c.text}" ${where}${c.faded ? ' (shown on hover)' : ''}`);
    });

    return finish();

    function finish() {
      extra.pageerrors = p.events.pageerrors;
      extra.console = [...new Set(p.events.console)].slice(0, 10);
      extra.dialogs = p.events.dialogs;
      extra.api = [...new Set(p.events.api)].slice(0, 20);
      return null;
    }
  } catch (e) {
    extra.error = String(e.message || e).slice(0, 300);
    log(`  ABORT: ${extra.error}`);
    for (const s of STEPS) if (result[s].reason === 'not reached') result[s] = { status: 'blocked', reason: 'aborted: ' + extra.error };
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopAll();
    const final =
      'UI ' + STEPS.map((s) => `${s}=${result[s].status === 'blocked' ? 'blocked' : result[s].status}`).join(' ') +
      ` pageerrors=${(extra.pageerrors || []).length}` + (reached === 'deeplink' ? ' reached=deeplink' : '') + (extra.error || extra.signin ? ' boot=fail' : '');
    for (const e of (extra.pageerrors || []).slice(0, 3)) log(`  pageerror: ${e}`);
    log(final);
    try {
      fs.writeFileSync(`${out}/result.json`, JSON.stringify({ label: job.label, final, steps: result, ...extra }, null, 2));
      fs.writeFileSync(`${out}/steps.log`, lines.join('\n') + '\n');
    } catch {}
  }
}

/** Event types the app listens for on the table host (set by the textTarget probe), via CDP. */
async function hostListeners(page) {
  try {
    const cdp = await page.context().newCDPSession(page);
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'window.__vuiHost' });
    if (!result || !result.objectId) return [];
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId, depth: 0 });
    await cdp.detach().catch(() => {});
    return [...new Set(listeners.map((l) => l.type).filter((t) => /row|open|activate|select/i.test(t)))];
  } catch {
    return [];
  }
}

/** Find the list's id the way the screens link to it, and go there. Only after a failed open. */
async function deepLink(p, proj, name, ready) {
  let screens = '';
  try {
    screens = fs.readFileSync(`${proj}/app/src/screens.ts`, 'utf8');
  } catch {}
  // The shapes the screens themselves build, then the common ones (a build that never links to a
  // list has no template, only a parser such as `#/list/<id>`).
  const shapes = [];
  for (const m of screens.matchAll(/#\/([\w-]+)\?(\w+)=\$\{/g)) shapes.push(`#/${m[1]}?${m[2]}=ID`);
  for (const m of screens.matchAll(/#\/([\w-]+)\/\$\{/g)) shapes.push(`#/${m[1]}/ID`);
  for (const w of ['list', 'lists']) shapes.push(`#/${w}/ID`, `#/${w}?id=ID`, `#/${w}?list=ID`);
  const id = await p.page.evaluate(async (needle) => {
    try {
      const r = await fetch('/api/lists?limit=100');
      const j = await r.json();
      const walk = (v) => {
        if (Array.isArray(v)) {
          for (const x of v) {
            const f = walk(x);
            if (f) return f;
          }
        } else if (v && typeof v === 'object') {
          if (Object.values(v).includes(needle) && v.id) return v.id;
          for (const x of Object.values(v)) {
            const f = walk(x);
            if (f) return f;
          }
        }
        return null;
      };
      return walk(j);
    } catch {
      return null;
    }
  }, name);
  if (!id) return null;
  // A shape counts when the list screen comes up with its add field and every read it makes
  // succeeds — a wrong shape hands the screen a wrong id, and its reads fail.
  for (const shape of [...new Set(shapes)]) {
    const hash = shape.replace('ID', id);
    const mark = p.events.api.length;
    await p.page.evaluate((h) => (location.hash = h), hash);
    await p.settle(700);
    await p.until(async () => !!(await ready()), 2500);
    await p.settle(300);
    const alertText = await p.page.evaluate(() => [...document.querySelectorAll('[role=alert]')].map((e) => e.textContent).join(' '));
    if ((await ready()) && p.events.api.length === mark && !/not found|no access|not allowed|could not/i.test(alertText)) return hash;
  }
  return null;
}

function findBrowser() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || `${process.env.HOME}/Library/Caches/ms-playwright`;
  const dirs = fs.readdirSync(root);
  const shells = dirs.filter((d) => d.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of shells) {
    for (const sub of ['chrome-headless-shell-mac-arm64', 'chrome-mac']) {
      for (const exe of ['chrome-headless-shell', 'headless_shell']) {
        const f = `${root}/${d}/${sub}/${exe}`;
        if (fs.existsSync(f)) return f;
      }
    }
  }
  const full = dirs.filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of full) {
    const f = `${root}/${d}/chrome-mac/Chromium.app/Contents/MacOS/Chromium`;
    if (fs.existsSync(f)) return f;
  }
  throw new Error('no cached Playwright chromium');
}

module.exports = { boot, stopAll, probe, Person, signIn, personas, cast, findBrowser, parseArgs, run };
if (require.main === module) (async () => {
  const jobs = parseArgs(process.argv.slice(2));
  if (!jobs.length) {
    console.error('usage: verify-ui.cjs <run-id>… | --project <dir> --lane <N>');
    process.exit(2);
  }
  for (const j of jobs) await run(j);
  console.log('VERIFY_UI_FINISHED');
})();
