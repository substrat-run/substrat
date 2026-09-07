/**
 * A tiny, buildless web page served by the worker at `GET /`, so the vertical is
 * clickable in a browser without a separate frontend build. It calls the same
 * API routes with the seeded user's `x-principal` header (a dev affordance — real
 * auth replaces it). Inline HTML/CSS/JS, no external resources.
 */
export const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>external-vertical</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; line-height: 1.5; }
  h1 { font-size: 20px; margin: 0; }
  .sub { color: #888; font-size: 13px; margin: 2px 0 20px; }
  .card { border: 1px solid #8883; border-radius: 12px; padding: 16px; margin: 16px 0; }
  .card h2 { font-size: 14px; margin: 0 0 12px; }
  .card h2 .tag { color: #888; font-weight: 400; }
  button { background: #3b6cf6; color: #fff; border: 0; border-radius: 8px; padding: 8px 14px; font-size: 14px; cursor: pointer; }
  button.ghost { background: #8882; color: inherit; }
  input { padding: 8px 10px; border: 1px solid #8885; border-radius: 8px; font-size: 14px; background: transparent; color: inherit; }
  .row { display: flex; gap: 8px; margin-bottom: 12px; }
  .row input { flex: 1; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: 7px 0; border-bottom: 1px solid #8882; font-size: 14px; }
  li:last-child { border-bottom: 0; }
  .mono { font-family: ui-monospace, monospace; color: #888; font-size: 12px; }
  .empty { color: #999; font-size: 13px; }
  #msg { font-size: 13px; margin-left: 10px; }
  #msg.err { color: #d33; } #msg.ok { color: #2a2; }
  code { background: #8882; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>
  <h1>external-vertical</h1>
  <p class="sub">A Substrat vertical from published packages, on <code>wrangler dev</code>.</p>

  <div class="card">
    <button id="seed">Seed world</button>
    <span id="msg"></span>
    <p class="mono" style="margin:12px 0 0">acting as user 01JZ0000000000000000000003</p>
  </div>

  <div class="card">
    <h2>Notes <span class="tag">— your own module</span></h2>
    <div class="row">
      <input id="text" placeholder="Write a note…" />
      <button id="add">Add</button>
    </div>
    <ul id="notes"><li class="empty">Seed the world, then add a note.</li></ul>
  </div>

  <div class="card">
    <h2>Work orders <span class="tag">— composed engine-workorder</span></h2>
    <ul id="workorders"><li class="empty">Empty — the engine is registered; creating one composes its in-scope function (see the README).</li></ul>
  </div>

<script>
  const USER = '01JZ0000000000000000000003';
  const H = { 'x-principal': USER, 'content-type': 'application/json' };
  const $ = (id) => document.getElementById(id);
  const say = (t, cls = '') => { const m = $('msg'); m.textContent = t; m.className = cls; };

  function render(id, items, empty) {
    const ul = $(id);
    ul.innerHTML = items.length ? items.map((t) => '<li>' + t + '</li>').join('')
      : '<li class="empty">' + empty + '</li>';
  }
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  // Every list read is a keyset PAGE: the body is the entries and the walk is a
  // 'Link: <…>; rel="next"' header (RFC 8288). Follow the URL — never assemble a
  // cursor — and stop when there is no next link. This walks the whole list; a
  // real screen would keep the link and render a "load more".
  async function walk(url) {
    const all = [];
    while (url) {
      const r = await fetch(url, { headers: H });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
      all.push(...(await r.json()));
      const link = r.headers.get('Link');
      const next = link && link.match(/<([^>]+)>;\\s*rel="next"/);
      url = next ? next[1] : null;
    }
    return all;
  }

  async function refresh() {
    try {
      const [notes, wos] = await Promise.all([walk('/api/notes'), walk('/api/workorders')]);
      render('notes', notes.map((n) => esc(n.text) + ' <span class="mono">' + n.created_at.slice(0, 19) + '</span>'),
        'No notes yet.');
      render('workorders', wos.map((w) => esc(w.title || w.id)),
        'Empty — engine registered, no create wired in this example.');
    } catch (e) { say('load failed: ' + e.message, 'err'); }
  }

  $('seed').onclick = async () => {
    say('seeding…');
    const r = await fetch('/seed', { method: 'POST' });
    say(r.ok ? 'world seeded ✓' : 'seed failed', r.ok ? 'ok' : 'err');
    refresh();
  };
  $('add').onclick = async () => {
    const text = $('text').value.trim();
    if (!text) return;
    const r = await fetch('/api/notes', { method: 'POST', headers: H, body: JSON.stringify({ text }) });
    if (r.ok) { $('text').value = ''; say('note added ✓', 'ok'); refresh(); }
    else { const b = await r.json().catch(() => ({})); say('add failed: ' + (b.error || r.status), 'err'); }
  };
  $('text').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('add').click(); });

  refresh();
</script>
</body>
</html>`;
