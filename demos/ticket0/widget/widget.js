/**
 * The ticket0 embed script — artboards 15–17 of the design handoff.
 *
 * Vanilla and self-contained on purpose: this runs on somebody else's page, so it
 * ships no framework, and it renders into a shadow root so the host page's CSS cannot
 * reach in and the widget's cannot leak out.
 *
 * Usage:
 *   <script src="https://desk.example/widget.js"
 *           data-api="https://desk.example"
 *           data-user="marcus@parcelbay.com"      (optional)
 *           data-signature="<hmac from YOUR server>"></script>
 *
 * The signature is computed by the host site's SERVER from a secret this script never
 * sees. That is the whole mechanism: the page can claim an identity because its
 * backend vouched for it, and a visitor cannot forge the claim in devtools.
 *
 * Dark mode follows the host page (`prefers-color-scheme`), because a widget that is
 * light on a dark site looks like an advert rather than part of the product.
 */
(function () {
  var script = document.currentScript;
  var API = (script && script.dataset.api) || new URL(script.src).origin;
  var USER = script && script.dataset.user;
  var SIGNATURE = script && script.dataset.signature;
  var STORE = 'ticket0:' + API;

  /**
   * One widget per page, and a way to take it down.
   *
   * A page with a client-side router — the documentation site is one — can run this
   * script more than once without ever reloading: the router adds the tag on the way
   * into a page and removes it on the way out, and removing a <script> undoes nothing
   * it did. Left alone that is two bubbles after one round trip, and a poll that
   * outlives the page it was polling for. So a second run replaces the first, and the
   * host page gets one verb, `window.ticket0.unmount()`, for the way out.
   */
  if (window.ticket0 && typeof window.ticket0.unmount === 'function') window.ticket0.unmount();
  /** Set by `unmount`. A refresh already in flight must not reschedule the poll. */
  var dead = false;

  var session = null;
  try {
    session = JSON.parse(localStorage.getItem(STORE) || 'null');
  } catch (e) {
    session = null;
  }

  var open = false;
  var waiting = false;
  /**
   * When the wait started, so it can end.
   *
   * The assistant does not always answer: a question the documentation does not cover
   * is escalated to a human, and no public message is ever produced. Without a ceiling
   * the dots spin for the rest of the session and the visitor is left watching an
   * animation that is never going to resolve.
   */
  var waitingSince = 0;
  var WAIT_CEILING = 20000;
  /** The wait ran out. Persistent, or the notice would show for one render and go. */
  var gaveUp = false;
  var seen = 0;
  var poll = null;
  var error = null;
  var messages = [];
  /**
   * Whether the "Did this help?" card is finished with.
   *
   * Once per conversation, not once per answer. It exists to catch the moment an
   * assistant answer either lands or does not; asking again after every reply turns a
   * useful question into a tic, and somebody who already said yes has answered.
   */
  var helpDone = false;

  // ── shadow root ───────────────────────────────────────────────────────────
  var host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483000';
  var root = host.attachShadow({ mode: 'open' });

  root.innerHTML =
    '<style>' +
    "@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap');" +
    ':host{--panel:#fff;--page:#fafafa;--line:#e7e7e3;--line-2:#efefec;--text:#17181a;' +
    '--sec:#55585e;--muted:#8a8d93;--visitor:#f1e9df;--visitor-t:#17181a;--assistant:#fff;' +
    '--chip:#a8500f;--chip-bg:#fbf0e6;--chip-bd:#ecd2b8;--green:#178a4c;--action:#c05310;' +
    '--launch:#17181a;--launch-fg:#fff;--ring:#fff;' +
    '--shadow:0 16px 40px rgba(20,20,25,.14)}' +
    '@media (prefers-color-scheme:dark){:host{--panel:#17181c;--page:#14151a;--line:#2a2c33;' +
    '--line-2:#24262c;--text:#ececed;--sec:#c9cbd1;--muted:#8b8f97;--visitor:#33291c;' +
    '--visitor-t:#ece5da;--assistant:#1e2025;--chip:#e8944d;--chip-bg:#2a2118;--chip-bd:#4a3826;' +
    '--green:#4fb87a;--launch:#ececed;--launch-fg:#17181a;--ring:#14151a;' +
    '--shadow:0 16px 40px rgba(0,0,0,.5)}}' +
    "*{box-sizing:border-box;font-family:'Geist',ui-sans-serif,system-ui,-apple-system,sans-serif}" +
    ".mono{font-family:'Geist Mono',ui-monospace,Menlo,monospace}" +
    /* 15 — launcher */
    '.launch{position:relative;width:48px;height:48px;border-radius:16px;border:0;cursor:pointer;' +
    'background:var(--launch);color:var(--launch-fg);box-shadow:var(--shadow);display:grid;' +
    'place-items:center;transition:transform .12s ease}' +
    '.launch:hover{transform:translateY(-2px)}' +
    '.badge{position:absolute;top:-5px;right:-5px;min-width:18px;height:18px;border-radius:9px;' +
    'background:#c05310;color:#fff;font:600 10px/18px Geist,sans-serif;text-align:center;' +
    'padding:0 4px;border:2px solid var(--ring)}' +
    /* 16 — panel */
    '.panel{width:360px;height:544px;max-height:calc(100vh - 48px);background:var(--panel);' +
    'border-radius:14px;overflow:hidden;display:flex;flex-direction:column;box-shadow:var(--shadow)}' +
    '.hd{display:flex;align-items:center;gap:10px;padding:13px 14px;border-bottom:1px solid var(--line)}' +
    '.mark{width:26px;height:26px;border-radius:7px;background:#17181a;color:#fff;display:grid;' +
    'place-items:center;font:600 13px Geist,sans-serif;flex:0 0 auto}' +
    '@media (prefers-color-scheme:dark){.mark{background:#ececed;color:#17181a}}' +
    '.hd b{font:600 13px Geist,sans-serif;color:var(--text);display:block}' +
    '.hd small{font:400 11px Geist,sans-serif;color:var(--muted);display:block;margin-top:1px}' +
    '.hd small.v{color:var(--green);display:flex;align-items:center;gap:5px}' +
    '.hd small.v i{width:6px;height:6px;border-radius:3px;background:var(--green);display:block}' +
    '.x{margin-left:auto;background:none;border:0;color:var(--muted);cursor:pointer;font-size:15px;' +
    'padding:2px 4px;line-height:1}.x:hover{color:var(--text)}' +
    '.log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:11px;background:var(--page)}' +
    '.by{font:400 11px Geist,sans-serif;color:var(--muted);margin:0 0 4px 3px}' +
    '.m{max-width:84%;padding:9px 12px;font:400 13px/1.6 Geist,sans-serif;white-space:pre-wrap;' +
    'word-wrap:break-word}' +
    '.them{background:var(--assistant);border:1px solid var(--line);color:var(--text);' +
    'align-self:flex-start;border-radius:10px 10px 10px 3px}' +
    '.me{background:var(--visitor);color:var(--visitor-t);align-self:flex-end;' +
    'border-radius:10px 10px 3px 10px}' +
    // Wraps rather than truncating: a documentation title chopped mid-word is an
    // orange smear, not a citation. UI font, not mono — mono is for ids and URLs, and
    // these are sentences.
    '.cites{align-self:flex-start;max-width:92%;display:flex;flex-direction:column;gap:4px;margin-top:-4px}' +
    '.cite{font:500 11px/1.45 Geist,sans-serif;color:var(--chip);background:var(--chip-bg);' +
    'border:1px solid var(--chip-bd);border-radius:4px;padding:4px 8px;text-decoration:none;' +
    'white-space:normal;overflow-wrap:anywhere}' +
    '.cite:hover{text-decoration:underline}' +
    '.cite-more{font:400 10px Geist,sans-serif;color:var(--muted);padding-left:2px}' +
    /* waiting */
    '.wait{align-self:flex-start;display:flex;align-items:center;gap:9px}' +
    '.dots{display:flex;gap:4px;padding:11px 13px;background:var(--assistant);' +
    'border:1px solid var(--line);border-radius:10px 10px 10px 3px}' +
    '.dots span{width:6px;height:6px;border-radius:3px;background:var(--muted);animation:t0blink 1.2s infinite}' +
    '.dots span:nth-child(2){animation-delay:.2s}.dots span:nth-child(3){animation-delay:.4s}' +
    '@keyframes t0blink{0%,80%,100%{opacity:.25}40%{opacity:1}}' +
    '.waitlabel{font:400 11px Geist,sans-serif;color:var(--muted)}' +
    /* did this help */
    '.help{align-self:flex-start;max-width:88%;background:var(--panel);border:1px solid var(--line);' +
    'border-radius:10px;padding:11px 12px}' +
    '.help p{margin:0 0 9px;font:500 12px Geist,sans-serif;color:var(--text)}' +
    '.help div{display:flex;gap:7px}' +
    '.hb{font:500 12px Geist,sans-serif;border-radius:6px;padding:6px 11px;cursor:pointer;' +
    'border:1px solid var(--line);background:var(--panel);color:var(--sec)}' +
    '.hb.yes{border-color:var(--green);color:var(--green)}' +
    '.escape{align-self:center;font:400 11px Geist,sans-serif;color:var(--muted);text-align:center}' +
    '.escape button{background:none;border:0;color:var(--action);cursor:pointer;font:500 11px Geist,sans-serif;padding:0}' +
    /* composer + footer */
    '.cp{border-top:1px solid var(--line);padding:10px;display:flex;gap:8px;background:var(--panel)}' +
    'textarea{flex:1;resize:none;border:1px solid var(--line);border-radius:8px;padding:9px 11px;' +
    'font:400 13px Geist,sans-serif;height:38px;max-height:110px;outline:none;background:var(--page);color:var(--text)}' +
    'textarea:focus{border-color:var(--action)}' +
    '.send{border:0;background:var(--action);color:#fff;border-radius:8px;padding:0 14px;cursor:pointer;' +
    'font:500 12px Geist,sans-serif}.send:disabled{opacity:.4;cursor:default}' +
    '.ft{padding:8px 14px;border-top:1px solid var(--line-2);background:var(--panel);' +
    'font:400 11px/1.5 Geist,sans-serif;color:var(--muted);display:flex;align-items:center;gap:10px}' +
    '.ft button{margin-left:auto;background:none;border:0;padding:0;cursor:pointer;' +
    'color:var(--action);font:500 11px Geist,sans-serif;white-space:nowrap}' +
    '.ft button:hover{text-decoration:underline}' +
    '.err{margin:10px 14px 0;padding:9px 11px;background:#fdf3f2;border:1px solid #e5c4c2;' +
    'color:#8f1d16;border-radius:8px;font:400 12px/1.5 Geist,sans-serif}' +
    '@media (prefers-color-scheme:dark){.err{background:#2a1a19;border-color:#5a3330;color:#f0b4b0}}' +
    '</style><div id="m"></div>';

  var mount = root.getElementById('m');
  function attach() {
    if (!host.isConnected) document.body.appendChild(host);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();

  // ── transport ─────────────────────────────────────────────────────────────
  function call(method, path, body) {
    return fetch(API + path, {
      method: method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      // Text first. A 502 from a proxy, a 204, or a CORS-stripped body is not JSON,
      // and `r.json()` on one throws a SyntaxError carrying no status — which is
      // exactly what `staleSession` needs to see a 404 or 403 and recover.
      return r.text().then(function (t) {
        var j = null;
        if (t) {
          try {
            j = JSON.parse(t);
          } catch (e) {
            j = null;
          }
        }
        if (!r.ok) {
          var err = new Error((j && (j.detail || j.title)) || t.slice(0, 120) || 'Request failed');
          err.status = r.status;
          throw err;
        }
        return j;
      });
    });
  }

  /**
   * The stored session no longer names anything.
   *
   * A token in `localStorage` outlives the desk that issued it: the session was reaped,
   * the scope was restored from a snapshot, the desk was reseeded in development. The
   * visitor did nothing wrong and can do nothing about it, so the widget throws the
   * dead capability away and opens a new one instead of showing them an id.
   */
  function staleSession(e) {
    return Boolean(session) && (e.status === 404 || e.status === 403);
  }

  function resetSession() {
    session = null;
    try {
      localStorage.removeItem(STORE);
    } catch (e) {
      /* private mode — nothing was stored to begin with */
    }
    messages = [];
    drawn = null;
    seen = 0;
    helpDone = false;
    waiting = false;
    gaveUp = false;
  }

  /** One recovery attempt. A second failure is a real error and is shown as one. */
  var recovering = false;

  /**
   * Polling, paced by what is actually happening.
   *
   * A support chat is not a stock ticker: the only moment that wants a fast poll is the
   * few seconds after you send something, and a panel sitting open in a background tab
   * wants none at all. So the interval follows the state instead of being one number,
   * and a hidden tab stops entirely and catches up when it comes back.
   *
   * This is a stopgap and worth naming as one. The right answer is a live connection,
   * and on this platform that means a WebSocket on the scope's own Durable Object —
   * the per-scope coordination point that already exists — rather than SSE, which
   * still needs something to push into it. Neither the router nor the DO carries an
   * Upgrade today, so that is platform work, not a change to this file.
   */
  var FAST = 1500;
  var IDLE = 10000;

  function schedule() {
    clearInterval(poll);
    poll = null;
    // A CLOSED panel still polls, slowly: the unread badge counts staff and assistant
    // replies that arrive while it is shut, and a widget that stops looking has
    // nothing to count. A hidden tab stops entirely, and a session that does not
    // exist yet has nothing to poll for.
    if (dead || document.hidden || !session) return;
    poll = setInterval(refresh, open && waiting ? FAST : IDLE);
  }

  function onVisibility() {
    if (!open) return;
    // Coming back is the one moment a poll is certainly worth making.
    if (!document.hidden) void refresh();
    schedule();
  }
  document.addEventListener('visibilitychange', onVisibility);

  var api = {
    unmount: function () {
      dead = true;
      clearInterval(poll);
      poll = null;
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('DOMContentLoaded', attach);
      host.remove();
      if (window.ticket0 === api) delete window.ticket0;
    },
  };
  window.ticket0 = api;

  function recover(e, retry) {
    if (recovering || !staleSession(e)) return false;
    recovering = true;
    resetSession();
    start()
      .then(retry)
      .catch(function (err) {
        error = String(err.message || err);
        draw();
      })
      .then(function () {
        recovering = false;
      });
    return true;
  }

  function start() {
    if (session) return Promise.resolve(session);
    var identity =
      USER && SIGNATURE ? { externalId: USER, email: USER, signature: SIGNATURE } : null;
    return call('POST', '/widget/sessions', { identity: identity }).then(function (s) {
      session = s;
      try {
        localStorage.setItem(STORE, JSON.stringify(s));
      } catch (e) {
        // Private mode, or storage full. The session is live either way; it just
        // will not survive a reload.
      }
      return s;
    });
  }

  function thread() {
    if (!session) return Promise.reject(new Error('no session'));
    return call(
      'GET',
      '/widget/sessions/' + session.sessionId + '/messages?token=' + encodeURIComponent(session.token),
    );
  }

  // ── render ────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function label(m) {
    if (m.author_kind === 'contact') return null;
    if (m.author_kind === 'assistant') return 'Assistant';
    if (m.author_kind === 'agent') return 'Support';
    return null;
  }

  /**
   * Artboard 17 — which of the three rungs this visitor is on.
   *
   * The identity signal is one quiet line, never a banner: a visitor should be able to
   * tell whether the desk knows who they are without feeling audited.
   */
  function rung() {
    if (session && session.verified)
      return {
        verified: true,
        sub: 'Hi — your site verified you',
        foot: 'Verified by this site — no support login needed.',
      };
    // Anonymous says nothing. Explaining that a conversation lives in this browser is
    // a fact about our storage, not an answer to the question they arrived with.
    return { verified: false, sub: 'Replies in a few minutes · 09:00–18:00 CET', foot: '' };
  }

  /**
   * The panel is built ONCE, then updated in place.
   *
   * It used to be re-rendered wholesale on every poll, which replaced the textarea
   * along with everything else — so anything half-typed vanished every two seconds and
   * the box was unusable. The composer is not derived from server state, so nothing
   * derived from server state may re-create it.
   */
  var built = false;

  function draw() {
    if (!open) {
      built = false;
      var unread = messages.length - seen;
      mount.innerHTML =
        '<button class="launch" id="o" aria-label="Open support chat">' +
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-4-.9L3 21l1.9-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z"/></svg>' +
        (unread > 0 ? '<span class="badge">' + unread + '</span>' : '') +
        '</button>';
      root.getElementById('o').onclick = function () {
        toggle(true);
      };
      return;
    }
    if (!built) buildPanel();
    renderChrome();
    renderLog();
  }

  /** The shell: header, an empty log, the composer, the footer. Handlers bound once. */
  function buildPanel() {
    mount.innerHTML =
      '<div class="panel"><div class="hd"><div class="mark">S</div>' +
      '<div><b>Support</b><small id="sub"></small></div>' +
      '<button class="x" id="c" aria-label="Close">\u2715</button></div>' +
      '<div id="errbox"></div>' +
      '<div class="log" id="l"></div>' +
      '<div class="cp"><textarea id="t" placeholder="Ask a question\u2026" rows="1"></textarea>' +
      '<button class="send" id="s">Send</button></div>' +
      '<div class="ft"><span id="ft"></span>' +
      '<button data-act="human">Talk to a human</button></div></div>';

    root.getElementById('c').onclick = function () {
      toggle(false);
    };
    var ta = root.getElementById('t');
    ta.onkeydown = function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        post(ta.value);
      }
    };
    root.getElementById('s').onclick = function () {
      post(root.getElementById('t').value);
    };
    // Always reachable. The "Did this help?" card is shown once and then gone, so the
    // route to a person cannot live only inside it.
    root.querySelector('.ft [data-act="human"]').onclick = function () {
      helpDone = true;
      post('Can a person take a look at this, please?');
    };

    // Delegated: the log's contents are replaced on every update, so a handler bound
    // to a button inside it would be bound to a button that no longer exists.
    root.getElementById('l').addEventListener('click', function (e) {
      var act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'yes') {
        helpDone = true;
        renderLog();
      } else if (act === 'human') {
        helpDone = true;
        post('Can a person take a look at this, please?');
      }
    });

    built = true;
    ta.focus();
  }

  /** The frame's variable parts: which rung the visitor is on, and any error. */
  function renderChrome() {
    var r = rung();
    var sub = root.getElementById('sub');
    sub.className = r.verified ? 'v' : '';
    sub.innerHTML = (r.verified ? '<i></i>' : '') + esc(r.sub);
    root.getElementById('ft').textContent = r.foot;
    root.getElementById('errbox').innerHTML = error
      ? '<div class="err">' + esc(error) + '</div>'
      : '';
  }

  /**
   * What the log last drew.
   *
   * Replacing `innerHTML` resets `scrollTop`, and this ran on every two-second poll —
   * so reading back through a conversation was impossible: the view was yanked away
   * before you finished a sentence. A poll that returns the same messages must not
   * touch the DOM at all.
   */
  var drawn = null;

  function renderLog() {
    var log = root.getElementById('l');
    var signature = JSON.stringify([
      messages.map(function (m) {
        return [m.id || m.body_text, (m.citations || []).length];
      }),
      waiting,
      gaveUp,
      helpDone,
      session && session.greeting,
    ]);
    if (signature === drawn) return;
    drawn = signature;

    // Follow the conversation down only if the reader was already at the bottom;
    // yanking the scroll while somebody reads back is its own small betrayal.
    var atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    var keep = log.scrollTop;

    var body = '';
    if (session && session.greeting && messages.length === 0) {
      body +=
        '<div class="by">Assistant</div><div class="m them">' + esc(session.greeting) + '</div>';
    }
    messages.forEach(function (m) {
      var l = label(m);
      if (l) body += '<div class="by">' + l + '</div>';
      body +=
        '<div class="m ' + (m.author_kind === 'contact' ? 'me' : 'them') + '">' +
        esc(m.body_text) +
        '</div>';
      // A field, not a convention. This used to lift a trailing `From "…" — url` line
      // out of the answer text, which worked only because the offline fallback wrote
      // one; the moment a real model answered, the chip silently disappeared.
      //
      // Two at most. The design shows one; a 360px panel with four stacked sources
      // under every answer buries the answer, and the rest are one click away.
      // Citations come from ingested documentation, which is content rather than
      // configuration. Anything but http(s) — `javascript:` above all — must not
      // reach an href.
      var cites = (m.citations || []).filter(function (c) {
        try {
          var scheme = new URL(c.url).protocol;
          return scheme === 'http:' || scheme === 'https:';
        } catch (e) {
          return false;
        }
      });
      if (cites.length) {
        body += '<div class="cites">';
        cites.slice(0, 2).forEach(function (c) {
          body +=
            '<a class="cite" href="' + esc(c.url) + '" target="_blank" rel="noreferrer">' +
            esc(c.title) +
            ' \u2197</a>';
        });
        if (cites.length > 2)
          body += '<span class="cite-more">+' + (cites.length - 2) + ' more source' +
            (cites.length - 2 === 1 ? '' : 's') + '</span>';
        body += '</div>';
      }
    });

    if (gaveUp) {
      // The assistant had nothing to add, or this desk keeps a human in the loop.
      // Say so, rather than animating at somebody forever.
      body +=
        '<div class="escape">No answer from the assistant on this one \u2014 ' +
        'a person will pick it up. <button data-act="human">Ask for a human now</button></div>';
    } else if (waiting) {
      body +=
        '<div class="wait"><div class="dots"><span></span><span></span><span></span></div>' +
        '<span class="waitlabel">Assistant is reading the docs\u2026</span></div>' +
        '<div class="escape">Taking long? <button data-act="human">Talk to a human</button> \u2014 we\u2019re online.</div>';
    } else if (
      !helpDone &&
      messages.length >= 2 &&
      messages[messages.length - 1].author_kind !== 'contact'
    ) {
      body +=
        '<div class="help"><p>Did this help?</p><div>' +
        '<button class="hb yes" data-act="yes">Yes, thanks</button>' +
        '<button class="hb" data-act="human">Talk to a human</button></div></div>';
    }

    log.innerHTML = body;
    // Bottom if they were following along, otherwise back where they were — never the
    // top, which is where an innerHTML swap leaves it.
    log.scrollTop = atBottom ? log.scrollHeight : keep;
  }

  /**
   * Time-based state, evaluated on the poll rather than inside a render.
   *
   * It used to live in `renderLog`, which meant rendering had a side effect: the flag
   * flipped as the notice was drawn, so the next render — two seconds later — no
   * longer met the condition and the notice disappeared again.
   */
  function tickWait() {
    if (waiting && Date.now() - waitingSince > WAIT_CEILING) {
      waiting = false;
      gaveUp = true;
      schedule();
    }
  }

  function refresh() {
    tickWait();
    if (!session) return Promise.resolve();
    return thread()
      .then(function (page) {
        var next = page.entries || [];
        // "Waiting" ends when something arrives that is not ours — not when our own
        // POST resolves, because the answer is produced out of band.
        var was = waiting;
        if (next.length > messages.length && next[next.length - 1].author_kind !== 'contact') {
          waiting = false;
          gaveUp = false;
        }
        if (was !== waiting) schedule();
        messages = next;
        if (open) seen = messages.length;
        draw();
      })
      .catch(function (e) {
        if (recover(e, refresh)) return;
        error = String(e.message || e);
        draw();
      });
  }

  function post(text) {
    text = (text || '').trim();
    if (!text) return;
    // Without a session there is nowhere to send it. Say so rather than reading
    // `session.sessionId` off null and leaving the dots spinning forever.
    if (!session) {
      error = 'Not connected — reopen the chat to start a new conversation.';
      waiting = false;
      draw();
      return;
    }
    var ta = root.getElementById('t');
    if (ta) {
      ta.value = '';
      ta.focus();
    }
    error = null;
    waiting = true;
    waitingSince = Date.now();
    gaveUp = false;
    schedule();
    messages = messages.concat([{ author_kind: 'contact', body_text: text }]);
    draw();
    call('POST', '/widget/sessions/' + session.sessionId + '/messages', {
      token: session.token,
      body: text,
    })
      .then(refresh)
      .catch(function (e) {
        waiting = false;
        // Re-send the message on the new session: the visitor typed it once and
        // should not have to notice that the old session had gone.
        if (
          recover(e, function () {
            return post(text);
          })
        )
          return;
        error = String(e.message || e);
        draw();
      });
  }

  function toggle(next) {
    open = next;
    if (!open) {
      // Not cleared — re-scheduled at the idle pace so the badge keeps counting.
      schedule();
      draw();
      return;
    }
    draw();
    start()
      .then(refresh)
      .then(schedule)
      .catch(function (e) {
        // A desk that does not embed here, or a rotated secret. Say which — and
        // disable the composer, because there is nothing behind it.
        error = String(e.message || e);
        draw();
        var ta = root.getElementById('t');
        var send = root.querySelector('.send');
        if (ta) ta.disabled = true;
        if (send) send.disabled = true;
      });
  }

  draw();
})();
