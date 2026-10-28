// Spotify Miniplayer Lyrics
// Runs on open.spotify.com. When the miniplayer (a Document Picture-in-Picture
// window) opens, injects a lyrics toggle + panel into it.
//
// Lyrics sources, in order:
//   1. Spotify's own lyrics (via bridge.js: passive capture of the page's lyrics
//      responses, or an on-demand request using the page's own session)
//   2. LRCLIB synced
//   3. NetEase synced (opt-in, via community proxy)
//   4. Spotify unsynced → LRCLIB plain → lyrics.ovh plain
//
// Layout: when lyrics are open we hide Spotify's artwork and put the panel where
// it was, layered beneath Spotify's hover controls.

(() => {
  'use strict';

  const TAG = '[MiniLyrics]';
  const LRCLIB = 'https://lrclib.net/api';
  const OVH = 'https://api.lyrics.ovh/v1';
  const NETEASE = 'https://music.xianqiao.wang/neteaseapiv2';
  const CLIENT_ID = 'SpotifyMiniLyrics v0.4.2 (personal browser extension)';
  const TICK_MS = 250;
  const MIN_ART_HEIGHT = 100;    // artwork area height (px) below which lyrics hide themselves
  const MIN_PANEL_HEIGHT = 220;  // fallback-only (no artwork found): window inner height needed
  const COMPACT_HEIGHT = 200;    // panel height (px) below which the compact style is used
  const CONTROLS_GAP_PX = 84;    // fallback-only: bottom strip left uncovered when no artwork is found
  const MAX_RETRIES = 5;
  const SETTINGS_KEY = 'sml:settings';

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const settings = { spotify: true, netease: false };

  let pip = null;
  let ui = null;
  let visible = false;
  let shown = false;
  let currentKey = null;
  let lyrics = null;
  let activeIdx = -1;
  let pendingTrack = null;
  let pendingSince = 0;
  let fetchSeq = 0;
  let rateLimitedUntil = 0;
  let userScrolledAt = 0;
  let retryTimer = null;
  const memCache = new Map();

  let lastRawPos = NaN;
  let lastChangeTs = 0;

  let art = null;
  let mode = 'body';
  let lastOcclusionCheck = 0;
  let shiftedRow = null;   // Spotify's control row we moved down
  let rowShift = 0;        // how far (px) we moved it
  let lastError = null;    // last exception (message + stack), for the debug dump
  let dumpTimer = null;

  // Spotify bridge state
  let bridgeReady = false;
  let latestCaptured = null;         // { id, at, data } – last lyrics response the page fetched itself
  const bridgePending = new Map();   // reqId → resolve
  let bridgeSeq = 0;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const q = (sel, root = document) => root.querySelector(sel);
  const text = (el) => (el ? el.textContent.trim() : '');
  const now = () => performance.now();

  function parseClock(s) {
    if (!s) return NaN;
    s = s.trim();
    const neg = s.startsWith('-');
    const parts = s.replace(/^-/, '').split(':').map((p) => parseInt(p, 10));
    if (!parts.length || parts.some((n) => Number.isNaN(n))) return NaN;
    let sec = 0;
    for (const p of parts) sec = sec * 60 + p;
    return neg ? -sec : sec;
  }

  function cleanTitle(t) {
    return t
      .replace(/\s*[-–]\s*(remaster(ed)?|live|mono|stereo|radio edit|single version|deluxe|bonus track|from .*|feat\.?.*|ft\.?.*)\b.*$/i, '')
      .replace(/\s*[(\[][^)\]]*(remaster|live|edit|version|mix|feat\.?|ft\.?|deluxe|bonus)[^)\]]*[)\]]/gi, '')
      .trim() || t;
  }

  function firstArtist(a) {
    return (a || '').split(/,|&|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bx\b/i)[0].trim() || a;
  }

  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

  function storageGet(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(key, (r) => resolve(r && r[key] !== undefined ? r[key] : null));
      } catch (_) { resolve(null); }
    });
  }
  function storageSet(key, val) {
    try { chrome.storage.local.set({ [key]: val }); } catch (_) { /* ignore */ }
  }

  async function cached(key, producer) {
    if (memCache.has(key)) return memCache.get(key);
    const stored = await storageGet(key);
    if (stored !== null) { memCache.set(key, stored); return stored; }
    const val = await producer();
    memCache.set(key, val);
    if (val) storageSet(key, val);
    return val;
  }

  function loadSettings() {
    try {
      chrome.storage.local.get(SETTINGS_KEY, (r) => Object.assign(settings, (r && r[SETTINGS_KEY]) || {}));
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && ch[SETTINGS_KEY]) Object.assign(settings, ch[SETTINGS_KEY].newValue || {});
      });
    } catch (_) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Reading Spotify's state (from the main tab's now-playing bar)
  // ---------------------------------------------------------------------------
  function getTrack() {
    let title = '', artist = '', album = '';
    try {
      const md = navigator.mediaSession && navigator.mediaSession.metadata;
      if (md && md.title) {
        title = md.title;
        artist = md.artist || '';
        album = md.album || '';
      }
    } catch (_) { /* ignore */ }

    if (!title) {
      const w = q('[data-testid="now-playing-widget"]');
      if (w) {
        title = text(q('[data-testid="context-item-info-title"]', w));
        artist = [...w.querySelectorAll('[data-testid="context-item-info-artist"]')]
          .map(text).filter(Boolean).join(', ');
      }
    }
    return title ? { title, artist, album } : null;
  }

  const TRACK_ID_RE = [/spotify(?::|%3A)track(?::|%3A)([A-Za-z0-9]{22})/, /\/track\/([A-Za-z0-9]{22})/];

  function idFromHref(h) {
    for (const re of TRACK_ID_RE) {
      const m = re.exec(h || '');
      if (m) return m[1];
    }
    return null;
  }

  function currentTrackId(track) {
    const w = q('[data-testid="now-playing-widget"]');
    if (w) {
      for (const a of w.querySelectorAll('a[href]')) {
        const id = idFromHref(a.getAttribute('href'));
        if (id) return id;
      }
      // Some layouts put the URI on a data attribute instead of a link.
      for (const el of w.querySelectorAll('[data-uri], [href]')) {
        const id = idFromHref(el.getAttribute('data-uri') || el.getAttribute('href'));
        if (id) return id;
      }
    }
    // Fallback: any track link on the page whose text is exactly the current title.
    if (track) {
      const want = norm(track.title);
      for (const a of document.querySelectorAll('a[href*="/track/"]')) {
        if (norm(a.textContent) === want) {
          const id = idFromHref(a.getAttribute('href'));
          if (id) return id;
        }
      }
    }
    return null;
  }

  function getPlayback() {
    let pos = parseClock(text(q('[data-testid="playback-position"]')));
    let dur = parseClock(text(q('[data-testid="playback-duration"]')));
    if (dur < 0 && pos >= 0) dur = pos - dur;

    const bar = q('[data-testid="progress-bar"]');
    if (bar && dur > 0) {
      const pct = parseFloat(bar.style.getPropertyValue('--progress-bar-transform'));
      if (!Number.isNaN(pct)) pos = (dur * pct) / 100;
    }
    return { pos, dur };
  }

  function estimatePosition() {
    const { pos } = getPlayback();
    const t = now();
    if (Number.isNaN(pos)) return NaN;
    if (pos !== lastRawPos) {
      lastRawPos = pos;
      lastChangeTs = t;
    }
    const since = (t - lastChangeTs) / 1000;
    return since < 1.5 ? lastRawPos + since : lastRawPos;
  }

  function seekTo(sec) {
    const { dur } = getPlayback();
    const bar = q('[data-testid="playback-progressbar"]') || q('[data-testid="progress-bar"]');
    if (!bar || !(dur > 0)) return;
    const r = bar.getBoundingClientRect();
    if (!r.width) return;
    const x = r.left + r.width * Math.min(0.999, Math.max(0, sec / dur));
    const y = r.top + r.height / 2;
    const target = document.elementFromPoint(x, y) || bar;
    const common = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, view: window };
    const fire = (type, extra) => {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      target.dispatchEvent(new Ctor(type, { ...common, ...extra }));
    };
    fire('pointerdown', { buttons: 1, pointerId: 1, isPrimary: true, pointerType: 'mouse' });
    fire('mousedown', { buttons: 1 });
    fire('pointerup', { buttons: 0, pointerId: 1, isPrimary: true, pointerType: 'mouse' });
    fire('mouseup', { buttons: 0 });
    fire('click', { buttons: 0 });
  }

  // ---------------------------------------------------------------------------
  // LRC parsing
  // ---------------------------------------------------------------------------
  const CREDIT_LINE = /^\s*(作词|作曲|编曲|制作人?|监制|混音|母带|录音|吉他|贝斯|鼓|键盘|和声|弦乐|出品|发行|lyrics?|composer|producer|arranger|mix(?:ing|ed)?|master(?:ing|ed)?|publish(?:er|ed)?|vocals?|guitar|program(?:ming)?|written|words|music)\s*(?:by)?\s*[:：]/i;

  function parseLrc(lrc, dropCredits) {
    const out = [];
    const re = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
    for (const raw of lrc.split(/\r?\n/)) {
      const stamps = [];
      let last = 0, m;
      re.lastIndex = 0;
      while ((m = re.exec(raw)) && m.index === last) {
        stamps.push(parseInt(m[1], 10) * 60 + parseFloat(m[2]));
        last = re.lastIndex;
      }
      if (!stamps.length) continue;
      const line = raw.slice(last).trim();
      if (dropCredits && CREDIT_LINE.test(line)) continue;
      for (const t of stamps) out.push({ t, text: line });
    }
    out.sort((a, b) => a.t - b.t);
    return out.length ? out : null;
  }

  // ---------------------------------------------------------------------------
  // Provider 1: Spotify's own lyrics (through bridge.js in the page world)
  // ---------------------------------------------------------------------------
  function normalizeSpotify(j) {
    const ly = j && j.lyrics;
    if (!ly || !Array.isArray(ly.lines) || !ly.lines.length) return null;
    const clean = (w) => { w = (w || '').trim(); return w === '♪' ? '' : w; };
    if (ly.syncType === 'LINE_SYNCED') {
      return { synced: ly.lines.map((l) => ({ t: Number(l.startTimeMs) / 1000, text: clean(l.words) })), source: 'Spotify' };
    }
    const plain = ly.lines.map((l) => clean(l.words)).join('\n').trim();
    return plain ? { plain, source: 'Spotify' } : null;
  }

  let bridgeHasToken = false;

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__sml !== true) return;
    const d = e.data;
    if (d.type === 'bridge-ready') {
      bridgeReady = true;
      bridgeHasToken = !!d.hasToken;
    } else if (d.type === 'lyrics') {
      const n = normalizeSpotify(d.data);
      memCache.set('sp:' + d.id, n);
      if (n) storageSet('sp:' + d.id, n);
      latestCaptured = { id: d.id, at: now(), data: n };
    } else if (d.type === 'lyrics-result') {
      const resolve = bridgePending.get(d.reqId);
      if (resolve) { bridgePending.delete(d.reqId); resolve(d); }
    }
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function pingBridge() {
    try { window.postMessage({ __sml: true, type: 'ping' }, location.origin); } catch (_) { /* ignore */ }
  }

  async function ensureBridge() {
    if (bridgeReady) return true;
    pingBridge();
    for (let i = 0; i < 10 && !bridgeReady; i++) await sleep(100);
    return bridgeReady;
  }

  function bridgeFetch(id) {
    return new Promise((resolve) => {
      const reqId = 'r' + (++bridgeSeq);
      bridgePending.set(reqId, resolve);
      window.postMessage({ __sml: true, type: 'get-lyrics', id, reqId }, location.origin);
      setTimeout(() => {
        if (bridgePending.has(reqId)) { bridgePending.delete(reqId); resolve({ error: 'timeout' }); }
      }, 8000);
    });
  }

  // Returns normalized lyrics, null (Spotify has none), or undefined (couldn't tell).
  // `diag` gets a short note about what happened, for the per-track console line.
  async function spotifyLookup(track, changedAt, diag) {
    if (!settings.spotify) { diag.spotify = 'off'; return undefined; }
    const id = currentTrackId(track);
    if (id) {
      const key = 'sp:' + id;
      if (memCache.has(key)) { diag.spotify = memCache.get(key) ? 'cached' : 'none'; return memCache.get(key); }
      const stored = await storageGet(key);
      if (stored) { memCache.set(key, stored); diag.spotify = 'cached'; return stored; }
      if (!(await ensureBridge())) { diag.spotify = 'bridge missing'; return undefined; }
      const r = await bridgeFetch(id);
      if (r.error) { diag.spotify = r.error; return undefined; }
      const n = r.data ? normalizeSpotify(r.data) : null;
      memCache.set(key, n);
      if (n) storageSet(key, n);
      diag.spotify = n ? (n.synced ? 'synced' : 'plain') : 'none';
      return n;
    }
    // Couldn't read the track id: accept lyrics the page fetched itself around this track change.
    if (latestCaptured && Math.abs(latestCaptured.at - changedAt) < 15000) {
      diag.spotify = 'captured';
      return latestCaptured.data;
    }
    diag.spotify = 'no track id';
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Provider 2: LRCLIB
  // ---------------------------------------------------------------------------
  async function api(path, params, signal) {
    if (now() < rateLimitedUntil) throw new Error('rate-limited');
    const url = new URL(LRCLIB + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, { signal, headers: { 'Lrclib-Client': CLIENT_ID } });
    if (res.status === 404) return null;
    if (res.status === 429 || res.status === 503) {
      let wait = parseInt(res.headers.get('Retry-After') || '', 10);
      if (!(wait > 0)) wait = res.status === 503 ? 2 : 10;
      wait = Math.min(wait, 120);
      rateLimitedUntil = now() + wait * 1000 * (1 + Math.random() * 0.3);
      throw new Error('rate-limited');
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function normalizeLrclib(rec) {
    return {
      synced: rec.syncedLyrics ? parseLrc(rec.syncedLyrics, false) : null,
      plain: rec.plainLyrics || null,
      instrumental: !!rec.instrumental,
      source: 'LRCLIB',
    };
  }

  async function lrclibLookup(track, dur) {
    const durOk = dur > 0 && dur <= 3600 ? Math.round(dur) : undefined;
    const key = `sml:${track.title}|${track.artist}`;
    if (memCache.has(key)) return memCache.get(key);
    const stored = await storageGet(key);
    if (stored) { memCache.set(key, stored); return stored; }

    const fa = firstArtist(track.artist);
    const attempts = [
      { track_name: track.title, artist_name: track.artist, album_name: track.album, duration: durOk },
    ];
    if (fa !== track.artist) attempts.push({ track_name: track.title, artist_name: fa, duration: durOk });
    const ct = cleanTitle(track.title);
    if (ct !== track.title) attempts.push({ track_name: ct, artist_name: fa, duration: durOk });

    let rec = null;
    for (const p of attempts) {
      rec = await api('/get', p);
      if (rec) break;
    }
    if (!rec) {
      const list = await api('/search', { track_name: ct, artist_name: fa });
      if (Array.isArray(list) && list.length) {
        const withLyrics = list.filter((r) => r.syncedLyrics || r.plainLyrics || r.instrumental);
        const pool = withLyrics.length ? withLyrics : list;
        rec = (durOk && pool.find((r) => Math.abs((r.duration || 0) - durOk) <= 3))
          || pool.find((r) => r.syncedLyrics)
          || pool[0];
      }
    }

    const result = rec ? normalizeLrclib(rec) : { notFound: true };
    memCache.set(key, result);
    if (rec) storageSet(key, result);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Provider 3 (opt-in): NetEase via community proxy
  // ---------------------------------------------------------------------------
  async function neteaseLookup(track, dur) {
    return cached(`ne:${track.title}|${track.artist}`, async () => {
      const ct = cleanTitle(track.title);
      const res = await fetch(`${NETEASE}/search?limit=10&type=1&keywords=${encodeURIComponent(ct + ' ' + firstArtist(track.artist))}`);
      if (!res.ok) return null;
      const j = await res.json();
      const songs = j && j.result && j.result.songs;
      if (!Array.isArray(songs) || !songs.length) return null;

      let pick = track.album ? songs.find((s) => s.album && norm(s.album.name) === norm(track.album)) : null;
      if (!pick && dur > 0) pick = songs.find((s) => Math.abs((s.duration || 0) / 1000 - dur) < 3);
      if (!pick) pick = songs.find((s) => norm(s.name) === norm(ct));
      if (!pick) return null;

      const lr = await fetch(`${NETEASE}/lyric?id=${encodeURIComponent(pick.id)}`);
      if (!lr.ok) return null;
      const lj = await lr.json();
      const lrcText = lj && lj.lrc && lj.lrc.lyric;
      if (!lrcText) return null;
      if (/纯音乐[,，]?\s*请欣赏/.test(lrcText)) return { instrumental: true, source: 'NetEase' };
      const synced = parseLrc(lrcText, true);
      return synced && synced.length >= 2 ? { synced, source: 'NetEase' } : null;
    });
  }

  // ---------------------------------------------------------------------------
  // Provider 4: lyrics.ovh (plain lyrics)
  // ---------------------------------------------------------------------------
  async function ovhLookup(track) {
    return cached(`ovh:${track.title}|${track.artist}`, async () => {
      const fa = firstArtist(track.artist);
      const tries = [[track.artist, track.title], [fa, track.title], [fa, cleanTitle(track.title)]];
      const seen = new Set();
      for (const [a, t] of tries) {
        const k = a + '|' + t;
        if (!a || !t || seen.has(k)) continue;
        seen.add(k);
        try {
          const res = await fetch(`${OVH}/${encodeURIComponent(a)}/${encodeURIComponent(t)}`);
          if (!res.ok) continue;
          const j = await res.json();
          let txt = (j && j.lyrics ? String(j.lyrics) : '').replace(/\r\n?/g, '\n').trim();
          txt = txt.replace(/^Paroles de la chanson[^\n]*\n+/i, '').trim();
          if (txt) return { plain: txt, source: 'lyrics.ovh' };
        } catch (e) {
          console.warn(TAG, 'lyrics.ovh', e);
        }
      }
      return null;
    });
  }

  // ---------------------------------------------------------------------------
  // Provider chain
  // ---------------------------------------------------------------------------
  function describe(r) {
    if (r === undefined) return 'unknown';
    if (!r) return 'none';
    if (r.synced) return 'synced';
    if (r.plain) return 'plain';
    if (r.instrumental) return 'instrumental';
    return 'none';
  }

  async function resolveLyrics(track, dur, changedAt) {
    const diag = {};
    const summary = () => Object.entries(diag).map(([k, v]) => `${k}: ${v}`).join(' · ');
    const done = (res) => {
      res.diag = summary();
      console.info(TAG, `"${track.title}" → ${res.source || (res.notFound ? 'not found' : 'error')} [${res.diag}]`);
      return res;
    };

    const sp = await spotifyLookup(track, changedAt, diag).catch((e) => { diag.spotify = 'error ' + e.message; return undefined; });
    if (sp && sp.synced) return done(sp);

    let lrc = null, lrcErr = null;
    try { lrc = await lrclibLookup(track, dur); diag.lrclib = describe(lrc); }
    catch (e) { lrcErr = e; diag.lrclib = e.message; }
    if (lrc && lrc.synced) return done(lrc);

    if (settings.netease) {
      const ne = await neteaseLookup(track, dur).catch((e) => { diag.netease = 'error ' + e.message; return null; });
      if (ne) diag.netease = describe(ne);
      if (ne && (ne.synced || ne.instrumental)) return done(ne);
    }

    if (sp && sp.plain) return done(sp);
    if (lrc && (lrc.plain || lrc.instrumental)) return done(lrc);

    const ovh = await ovhLookup(track).catch((e) => { diag.ovh = 'error ' + e.message; return null; });
    diag.ovh = diag.ovh || describe(ovh);
    if (ovh) return done(ovh);

    if (lrcErr) { lrcErr.diag = summary(); done({ notFound: true }); throw lrcErr; }
    return done({ notFound: true });
  }

  async function loadLyrics(track, dur, changedAt, attempt = 0) {
    const seq = ++fetchSeq;
    clearTimeout(retryTimer);
    lyrics = null;
    activeIdx = -1;
    render();

    const cooldown = rateLimitedUntil - now();
    if (cooldown > 0 && attempt > 0) {
      scheduleRetry(track, dur, changedAt, attempt, cooldown, seq);
      return;
    }

    try {
      const res = await resolveLyrics(track, dur, changedAt);
      if (seq !== fetchSeq) return;
      lyrics = res;
    } catch (e) {
      if (seq !== fetchSeq) return;
      if (e.message !== 'rate-limited') console.warn(TAG, e);
      if (e.message === 'rate-limited' && attempt < MAX_RETRIES) {
        scheduleRetry(track, dur, changedAt, attempt, Math.max(1000, rateLimitedUntil - now()), seq);
        return;
      }
      lyrics = {
        error: e.message === 'rate-limited'
          ? 'Lyrics service is busy. Click to retry.'
          : 'Could not load lyrics. Click to retry.',
        retry: () => loadLyrics(track, dur, changedAt, 0),
        diag: e.diag,
      };
    }
    render();
  }

  function scheduleRetry(track, dur, changedAt, attempt, waitMs, seq) {
    const secs = Math.ceil(waitMs / 1000);
    lyrics = {
      error: `Lyrics service is busy, retrying in ${secs}s… (click to retry now)`,
      retry: () => loadLyrics(track, dur, changedAt, attempt + 1),
    };
    render();
    retryTimer = setTimeout(() => {
      if (seq !== fetchSeq) return;
      loadLyrics(track, dur, changedAt, attempt + 1);
    }, waitMs + 100);
  }

  // ---------------------------------------------------------------------------
  // UI inside the PiP window
  // ---------------------------------------------------------------------------
  const CSS = `
    [data-sml-hide] { visibility: hidden !important; }

    #sml-toggle {
      position: fixed; top: 10px; right: 10px; z-index: 2147483647;
      width: 32px; height: 32px; border-radius: 50%; border: 0; padding: 0;
      background: rgba(0,0,0,.55); color: #fff; cursor: pointer; opacity: .85;
      display: flex; align-items: center; justify-content: center;
      transition: opacity .15s, background .15s, transform .15s;
    }
    #sml-toggle:hover { opacity: 1; background: rgba(0,0,0,.8); transform: scale(1.06); }
    #sml-toggle.on { color: #1ed760; }
    #sml-toggle svg { width: 18px; height: 18px; fill: currentColor; }

    #sml-panel {
      position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 0;
      pointer-events: none; /* let Spotify's artwork see the mouse; wheel/click are forwarded by JS */
      display: none; flex-direction: column; box-sizing: border-box; overflow: hidden;
      background: linear-gradient(180deg, #232323 0%, #121212 100%);
      color: #fff; font-family: "Spotify Mix", CircularSp, "Helvetica Neue", Arial, sans-serif;
      -webkit-font-smoothing: antialiased; margin: 0; padding: 0;
    }
    #sml-panel.open { display: flex; }
    #sml-panel.sml-top { z-index: 2147483646; }
    #sml-panel::after {
      content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 90px;
      background: linear-gradient(to bottom, rgba(18,18,18,0), rgba(18,18,18,.85)); pointer-events: none;
    }
    #sml-head {
      height: 48px; box-sizing: border-box; padding: 18px 56px 0 16px; flex: none;
      font-size: 11px; letter-spacing: .04em; text-transform: uppercase;
      opacity: .6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #sml-list {
      position: relative; /* so line offsetTop is measured from the list, not the panel */
      flex: 1; overflow-y: auto; padding: 6px 16px 150px; scrollbar-width: none; overscroll-behavior: contain;
      -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 28px, #000 calc(100% - 70px), transparent 100%);
      mask-image: linear-gradient(to bottom, transparent 0, #000 28px, #000 calc(100% - 70px), transparent 100%);
    }
    #sml-list::-webkit-scrollbar { display: none; }
    .sml-line {
      font-size: 17px; font-weight: 700; line-height: 1.3; padding: 6px 0; margin: 0;
      color: rgba(255,255,255,.42); cursor: pointer; transform-origin: left center;
      transition: color .25s ease, transform .25s ease;
    }
    .sml-line.past { color: rgba(255,255,255,.75); }
    .sml-line.active { color: #fff; transform: scale(1.04); }
    .sml-line.empty { color: rgba(255,255,255,.3); font-size: 14px; }
    .sml-plain { white-space: pre-wrap; font-size: 15px; font-weight: 600; line-height: 1.55; color: #fff; margin: 0; }
    .sml-status { padding: 24px 8px; text-align: center; font-size: 14px; font-weight: 600; opacity: .8; }
    .sml-status.sml-clickable { cursor: pointer; text-decoration: underline dotted; }
    .sml-status.sml-clickable:hover { opacity: 1; }
    .sml-credit { display: block; margin-top: 18px; font-size: 10px; opacity: .45; text-align: center; }

    /* compact style for small windows */
    #sml-panel.sml-compact #sml-head { height: 30px; padding: 9px 44px 0 12px; font-size: 9px; }
    #sml-panel.sml-compact #sml-list {
      padding: 2px 12px 70px;
      -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 14px, #000 calc(100% - 40px), transparent 100%);
      mask-image: linear-gradient(to bottom, transparent 0, #000 14px, #000 calc(100% - 40px), transparent 100%);
    }
    #sml-panel.sml-compact .sml-line { font-size: 14px; padding: 4px 0; }
    #sml-panel.sml-compact .sml-line.empty { font-size: 12px; }
    #sml-panel.sml-compact .sml-plain { font-size: 13px; }
    #sml-panel.sml-compact .sml-status { padding: 10px 8px; font-size: 12px; }
    #sml-panel.sml-compact::after { height: 50px; }
    #sml-toggle.sml-compact { width: 26px; height: 26px; top: 6px; right: 6px; }
    #sml-toggle.sml-compact svg { width: 14px; height: 14px; }
    .sml-diag { font-size: 10px; opacity: .5; text-align: center; padding: 0 8px 12px; word-break: break-word; }
  `;

  const MIC_SVG = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.426 2.574a2.831 2.831 0 0 0-4.797 1.55l3.247 3.247a2.831 2.831 0 0 0 1.55-4.797zM10.5 8.118l-2.619-2.62A63303.13 63303.13 0 0 0 4.74 9.075L2.065 12.12a1.03 1.03 0 0 0 .034 1.46l.347.347a1.03 1.03 0 0 0 1.46.034l3.045-2.676c1.2-1.055 2.5-2.164 3.549-3.167zm-3.5 2.7l1.253-1.102 1.1 1.1-1.252 1.102-1.1-1.1z"/></svg>`;

  function buildUI(win) {
    const doc = win.document;

    const style = doc.createElement('style');
    style.id = 'sml-style';
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);

    const root = doc.createElement('div');
    root.id = 'sml-root';

    const toggle = doc.createElement('button');
    toggle.id = 'sml-toggle';
    toggle.type = 'button';
    toggle.title = 'Lyrics (L)';
    toggle.setAttribute('aria-label', 'Toggle lyrics');
    toggle.innerHTML = MIC_SVG;
    toggle.addEventListener('click', (e) => { e.stopPropagation(); setVisible(!visible); });
    root.appendChild(toggle);

    const panel = doc.createElement('div');
    panel.id = 'sml-panel';
    const head = doc.createElement('div');
    head.id = 'sml-head';
    const list = doc.createElement('div');
    list.id = 'sml-list';
    list.addEventListener('wheel', () => { userScrolledAt = now(); }, { passive: true });
    list.addEventListener('touchmove', () => { userScrolledAt = now(); }, { passive: true });
    panel.append(head, list);

    doc.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && /^(input|textarea)$/i.test(t.tagName)) return;
      if (e.key === 'l' || e.key === 'L') setVisible(!visible);
      if (e.key === 'd' || e.key === 'D') dumpDebug('manual');
    });

    // The panel ignores the mouse (so Spotify's hover controls work); wheel and clicks that land
    // inside its area are forwarded here, unless they hit one of Spotify's buttons.
    const overPanel = (e) => {
      if (!shown) return false;
      const r = panel.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    };
    doc.addEventListener('wheel', (e) => {
      if (!overPanel(e)) return;
      const step = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? list.clientHeight : 1;
      list.scrollTop += e.deltaY * step;
      userScrolledAt = now();
      e.preventDefault();
    }, { passive: false, capture: true });
    doc.addEventListener('click', (e) => {
      if (!overPanel(e)) return;
      if (e.target.closest && e.target.closest('button, a, input, [role="button"], [role="slider"], #sml-root')) return;
      const hit = [...list.querySelectorAll('.sml-line')].find((el) => {
        const r = el.getBoundingClientRect();
        return e.clientY >= r.top && e.clientY <= r.bottom && e.clientX >= r.left && e.clientX <= r.right;
      });
      if (hit) hit.click();
    }, true);

    (doc.body || doc.documentElement).appendChild(root);
    ui = { doc, root, style, toggle, panel, head, list };
    layout();
    render();
  }

  function setVisible(v) {
    visible = v;
    mode = 'body';
    if (visible && pip) {
      userScrolledAt = 0;
      clearTimeout(dumpTimer);
      dumpTimer = setTimeout(() => dumpDebug('auto'), 3000);
    }
    layout();
    render();
  }

  // ---- debug dump (shown on the extension's Options page) ---------------------

  function describeEl(el) {
    const bits = [el.tagName.toLowerCase()];
    try {
      const r = el.getBoundingClientRect();
      const cs = el.ownerDocument.defaultView.getComputedStyle(el);
      if (el.id) bits.push('#' + el.id);
      const tid = el.getAttribute('data-testid');
      if (tid) bits.push(`[testid=${tid}]`);
      const cls = [...el.classList].slice(0, 4).join('.');
      if (cls) bits.push('.' + cls);
      bits.push(`@${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      bits.push('pos=' + cs.position);
      if (cs.zIndex !== 'auto') bits.push('z=' + cs.zIndex);
      if (cs.transform !== 'none') bits.push('transform');
      if (cs.translate && cs.translate !== 'none') bits.push('translate=' + cs.translate);
      if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)') bits.push('bg=' + cs.backgroundColor);
      if (cs.backgroundImage !== 'none') bits.push('bgimg');
      if (cs.opacity !== '1') bits.push('op=' + cs.opacity);
      if (cs.visibility !== 'visible') bits.push(cs.visibility);
      if (cs.display === 'none') bits.push('display:none');
      if (cs.pointerEvents !== 'auto') bits.push('pe=' + cs.pointerEvents);
      if (cs.overflow !== 'visible') bits.push('ov=' + cs.overflow);
      const label = el.getAttribute('aria-label');
      if (label) bits.push(JSON.stringify(label));
      if (el.tagName === 'IMG' || el.tagName === 'VIDEO') bits.push('src=' + (el.getAttribute('src') || '').slice(0, 50));
      if (!el.children.length) {
        const t = el.textContent.trim();
        if (t) bits.push('text=' + JSON.stringify(t.slice(0, 40)));
      }
    } catch (e) { bits.push('err=' + e.message); }
    return bits.join(' ');
  }

  function dumpDebug(reason) {
    if (!ui || !pip) return;
    const doc = ui.doc;
    const out = [];
    try {
      let version = '?';
      try { version = chrome.runtime.getManifest().version; } catch (_) { /* ignore */ }
      out.push(`reason=${reason} version=${version} time=${new Date().toISOString()}`);
      out.push(`window=${pip.innerWidth}x${pip.innerHeight} visible=${visible} shown=${shown} mode=${mode} rowShift=${rowShift}`);
      out.push(`lyrics=${lyrics ? (lyrics.synced ? 'synced' : lyrics.plain ? 'plain' : lyrics.error ? 'error' : 'none') : 'null'} source=${lyrics && lyrics.source} diag=${lyrics && lyrics.diag}`);
      out.push('lastError=' + (lastError || 'none'));
      out.push('panel: ' + describeEl(ui.panel) + ' parent=' + (ui.panel.parentElement ? describeEl(ui.panel.parentElement) : 'none'));
      out.push('art: ' + (art ? describeEl(art) : 'none'));
      out.push('ctrl rules: ' + ((doc.getElementById('sml-ctrl') || {}).textContent || '(none)'));
      out.push('--- DOM (body) ---');
      let count = 0;
      const walk = (el, depth) => {
        if (count++ > 600) return;
        out.push('  '.repeat(depth) + describeEl(el));
        for (const c of el.children) walk(c, depth + 1);
      };
      walk(doc.body, 0);
      out.push('--- hit stack at panel centre ---');
      const r = ui.panel.getBoundingClientRect();
      ui.panel.style.pointerEvents = 'auto';
      try {
        for (const el of doc.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)) out.push('  ' + describeEl(el));
      } finally { ui.panel.style.pointerEvents = ''; }
    } catch (e) {
      out.push('dump failed: ' + (e.stack || e.message));
    }
    storageSet('sml:debug', out.join('\n'));
    console.info(TAG, 'debug dump saved (see extension Options page)');
  }

  // ---- layout -------------------------------------------------------------

  function findArt(doc) {
    const W = pip.innerWidth, H = pip.innerHeight;
    let best = null, bestArea = 0;
    for (const el of doc.querySelectorAll('img, video, canvas')) {
      if (el.closest('#sml-panel, #sml-root')) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { best = el; bestArea = area; }
    }
    return best && bestArea >= 0.2 * W * H ? best : null;
  }

  function setRect(panel, r) {
    const s = panel.style;
    const set = (k, v) => { v = Math.round(v) + 'px'; if (s[k] !== v) s[k] = v; };
    set('left', r.left); set('top', r.top); set('width', r.width); set('height', r.height);
  }

  function mount(panel, parent) {
    if (panel.parentElement !== parent || parent.firstChild !== panel) {
      parent.insertBefore(panel, parent.firstChild);
    }
  }

  function isOccluded() {
    const doc = ui.doc, panel = ui.panel;
    const r = ui.list.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) return false;
    const pts = [[r.left + r.width * 0.5, r.top + r.height * 0.3], [r.left + r.width * 0.3, r.top + r.height * 0.6]];
    panel.style.pointerEvents = 'auto'; // hit-testing ignores pointer-events:none elements
    try {
      for (const [x, y] of pts) {
        const stack = doc.elementsFromPoint(x, y);
        if (!stack.some((el) => el === panel || panel.contains(el))) continue;
        for (const el of stack) {
          if (el === panel || panel.contains(el)) break;
          if (blocksView(el)) return true;
        }
      }
      return false;
    } finally {
      panel.style.pointerEvents = '';
    }
  }

  // ---- Spotify's hover controls: move the button row down next to the seek bar ----

  // The play/pause button of Spotify's hover controls: must sit inside the artwork area.
  function findPlayButton(doc, artRect) {
    const inside = (r) => r.width > 0 && r.height > 0 &&
      r.left + r.width / 2 > artRect.left && r.left + r.width / 2 < artRect.right &&
      r.top + r.height / 2 > artRect.top && r.top + r.height / 2 < artRect.bottom;
    const b = doc.querySelector('[data-testid="control-button-playpause"]');
    if (b && inside(b.getBoundingClientRect())) return b;
    let best = null, bestArea = 0;
    for (const el of doc.querySelectorAll('button')) {
      if (el.closest('#sml-root, #sml-panel')) continue;
      const r = el.getBoundingClientRect();
      if (!inside(r)) continue;
      const a = r.width * r.height;
      if (a > bestArea) { best = el; bestArea = a; }
    }
    return best;
  }

  // Returns Spotify's seek-bar element (or a time label next to it) inside the artwork area.
  function findSeekEl(doc, artRect) {
    const sels = ['[data-testid="playback-progressbar"]', '[data-testid="progress-bar"]', 'input[type="range"]',
      '[role="slider"]', '[data-testid="playback-position"]'];
    const ok = (el) => {
      if (el.closest('#sml-panel, #sml-root')) return false;
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.top > artRect.top + artRect.height / 2 && r.top < artRect.bottom + 2;
    };
    for (const s of sels) for (const el of doc.querySelectorAll(s)) if (ok(el)) return el;
    for (const el of doc.querySelectorAll('span, div')) {
      if (el.children.length || !/^\d+:\d\d$/.test(el.textContent.trim())) continue;
      if (ok(el)) return el;
    }
    return null;
  }

  // A CSS selector built from an element's own classes, so a rule survives React re-rendering it.
  function selectorFor(el) {
    const cls = [...el.classList].filter((c) => /^[A-Za-z_][\w-]*$/.test(c));
    if (!cls.length) return null;
    return el.tagName.toLowerCase() + '.' + cls.map((c) => CSS.escape(c)).join('.');
  }

  function setControlRules(doc, css) {
    let st = doc.getElementById('sml-ctrl');
    if (!st) { st = doc.createElement('style'); st.id = 'sml-ctrl'; (doc.head || doc.documentElement).appendChild(st); }
    if (st.textContent !== css) st.textContent = css;
  }

  function restoreControls() {
    if (ui) setControlRules(ui.doc, '');
    shiftedRow = null;
    rowShift = 0;
  }

  function adjustControls(doc, artRect) {
    const play = findPlayButton(doc, artRect);
    if (!play) return; // controls not rendered right now; any earlier rules stay in place
    const seek = findSeekEl(doc, artRect);

    // The button row: smallest ancestor holding 4+ buttons. It must be part of the hover overlay,
    // never the artwork container itself (moving that would re-layer it above the lyrics).
    let row = play.parentElement;
    while (row && row !== doc.body && row.querySelectorAll('button').length < 4) row = row.parentElement;
    if (!row || row === doc.body || row.contains(art)) return;
    let moveTargets = [row];
    if (seek && row.contains(seek)) {
      // Buttons and seek bar share one container: move the buttons individually instead.
      moveTargets = [...row.querySelectorAll('button')].filter((b) => !seek.contains(b) && !b.closest('#sml-root'));
      if (!moveTargets.length) return;
    }
    if (shiftedRow !== row) { shiftedRow = row; rowShift = 0; }

    // Where the controls would sit without our shift, and where we want their bottom edge.
    const rects = moveTargets.map((el) => el.getBoundingClientRect()).filter((r) => r.height > 0);
    if (!rects.length) return; // controls not rendered right now
    const bottom = Math.max(...rects.map((r) => r.bottom));
    const natural = bottom - rowShift;
    const seekTop = seek ? seek.getBoundingClientRect().top : artRect.bottom - 44;
    const want = Math.min(artRect.height, Math.max(0, seekTop - 6 - natural));
    if (Math.abs(want - rowShift) > 1) rowShift = want;

    // Overlay wrappers between the row and the artwork container: remove their dimming so the
    // lyrics stay readable while the controls are shown.
    const dimSels = new Set();
    let el = row.parentElement;
    while (el && el !== doc.body && !el.contains(art)) {
      const s = selectorFor(el);
      if (s) dimSels.add(s);
      el = el.parentElement;
    }

    const css = [];
    // Any non-zero translate re-layers an element, so only ever apply a real shift, and only to
    // selectors that match nothing holding the artwork.
    const moveSels = new Set(moveTargets.map(selectorFor).filter(Boolean));
    for (const s of moveSels) {
      let bad = false;
      try { for (const m of doc.querySelectorAll(s)) if (m.contains(art) || m.contains(ui.panel)) { bad = true; break; } }
      catch (_) { bad = true; }
      if (bad) moveSels.delete(s);
    }
    if (rowShift >= 1) {
      if (moveSels.size) css.push(`${[...moveSels].join(', ')} { translate: 0 ${Math.round(rowShift)}px !important; }`);
      else for (const t of moveTargets) t.style.translate = `0 ${Math.round(rowShift)}px`;
    }
    if (dimSels.size) {
      css.push(`${[...dimSels].join(', ')} { background: transparent !important; background-image: none !important; ` +
        'backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; }');
    }
    setControlRules(doc, css.join('\n'));
  }

  function blocksView(el) {
    const tag = el.tagName;
    if (tag === 'IMG' || tag === 'VIDEO' || tag === 'CANVAS') return true;
    const cs = ui.doc.defaultView.getComputedStyle(el);
    if (parseFloat(cs.opacity) < 0.1) return false;
    // The artwork container paints the album colour as a gradient; if it is above us, we're hidden.
    if (cs.backgroundImage !== 'none' && art && el.contains(art)) return true;
    const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const parts = m[1].split(/[\s,/]+/).filter(Boolean);
      const a = parts.length >= 4 ? parseFloat(parts[3]) : 1;
      if (a >= 0.9) return true;
    }
    return false;
  }

  function layout() {
    if (!ui || !pip) return;
    const doc = ui.doc, panel = ui.panel, body = doc.body || doc.documentElement;

    if (!ui.root.isConnected) body.appendChild(ui.root);
    if (!ui.style.isConnected) (doc.head || doc.documentElement).appendChild(ui.style);

    // Lyrics can show whenever Spotify draws a real artwork square tall enough for a few lines.
    // The compact strip layout (tiny thumbnail) has no such square, so nothing shows there.
    const found = findArt(doc);
    const foundRect = found ? found.getBoundingClientRect() : null;
    const canShow = found ? foundRect.height >= MIN_ART_HEIGHT : pip.innerHeight >= MIN_PANEL_HEIGHT;
    const wantShown = visible && canShow;
    const newArt = wantShown ? found : null;

    if (art && art !== newArt) art.removeAttribute('data-sml-hide');
    art = newArt;
    if (art && !art.hasAttribute('data-sml-hide')) art.setAttribute('data-sml-hide', '');

    const compact = canShow && (found ? foundRect.height : pip.innerHeight) < COMPACT_HEIGHT;
    ui.toggle.style.display = canShow ? '' : 'none';
    ui.toggle.classList.toggle('on', visible);
    ui.toggle.classList.toggle('sml-compact', compact);
    ui.toggle.title = 'Lyrics (L)';

    if (!wantShown) {
      if (shown) { shown = false; panel.classList.remove('open'); restoreControls(); }
      return;
    }

    let rect, parent, top = false, artRect = null;
    if (art) {
      // Cover the whole artwork area, including the coloured padding Spotify draws around the
      // image (assume the padding is symmetric top/bottom), edge to edge horizontally.
      artRect = foundRect;
      rect = { left: 0, top: 0, width: pip.innerWidth, height: Math.min(pip.innerHeight, artRect.bottom + artRect.top) };
      parent = (mode === 'stage' && art.parentElement) ? art.parentElement : body;
      top = mode === 'top';
    } else {
      rect = { left: 0, top: 0, width: pip.innerWidth, height: Math.max(0, pip.innerHeight - CONTROLS_GAP_PX) };
      parent = body;
      top = true;
    }

    mount(panel, parent);
    // Inside a positioned/transformed container, "fixed" is relative to that container.
    let anchored = false;
    if (parent !== body) {
      const cs = doc.defaultView.getComputedStyle(parent);
      anchored = cs.position !== 'static' || cs.transform !== 'none' || (cs.translate && cs.translate !== 'none');
    }
    if (anchored) {
      const c = parent.getBoundingClientRect();
      panel.style.position = 'absolute';
      rect = { left: rect.left - c.left, top: rect.top - c.top, width: rect.width, height: rect.height };
    } else {
      panel.style.position = 'fixed';
    }
    setRect(panel, rect);
    panel.classList.toggle('sml-top', top);
    panel.classList.toggle('sml-compact', rect.height < COMPACT_HEIGHT);
    if (!shown) { shown = true; panel.classList.add('open'); render(); }

    // Best effort only: a failure here must never keep the panel from showing.
    if (artRect) {
      try { adjustControls(doc, artRect); }
      catch (e) { noteError('adjustControls', e); }
    }

    if (!top && now() - lastOcclusionCheck > 1000) {
      lastOcclusionCheck = now();
      if (isOccluded()) {
        mode = mode === 'body' ? 'stage' : 'top';
        console.info(TAG, 'lyrics panel was covered, switching layout mode to', mode);
      }
    }
  }

  // ---- rendering ----------------------------------------------------------

  function render() {
    if (!ui || !shown) return;
    const { list, head, doc } = ui;
    const track = getTrack();
    head.textContent = track ? `${track.title} · ${track.artist}` : 'Lyrics';
    list.replaceChildren();

    const status = (msg, onClick, diag) => {
      const d = doc.createElement('div');
      d.className = 'sml-status' + (onClick ? ' sml-clickable' : '');
      d.textContent = msg;
      if (onClick) d.addEventListener('click', onClick);
      list.appendChild(d);
      if (diag) {
        const s = doc.createElement('div');
        s.className = 'sml-diag';
        s.textContent = diag;
        list.appendChild(s);
      }
    };

    if (!track) return status('Nothing playing');
    if (!lyrics) return status('Loading lyrics…');
    if (lyrics.error) return status(lyrics.error, lyrics.retry, lyrics.diag);
    if (lyrics.notFound) return status('No lyrics found for this track', null, lyrics.diag);
    if (lyrics.instrumental) return status('♪ Instrumental');

    if (lyrics.synced) {
      lyrics.synced.forEach((ln, i) => {
        const p = doc.createElement('p');
        p.className = 'sml-line' + (ln.text ? '' : ' empty');
        p.textContent = ln.text || '♪';
        p.dataset.i = i;
        p.addEventListener('click', () => seekTo(ln.t));
        list.appendChild(p);
      });
      activeIdx = -1;
      updateActive(true);
    } else if (lyrics.plain) {
      const pre = doc.createElement('p');
      pre.className = 'sml-plain';
      pre.textContent = lyrics.plain;
      list.appendChild(pre);
    } else {
      status('No lyrics found for this track');
    }
    const credit = doc.createElement('span');
    credit.className = 'sml-credit';
    credit.textContent = 'Lyrics via ' + (lyrics.source || 'LRCLIB');
    list.appendChild(credit);
  }

  function updateActive(force) {
    if (!ui || !shown || !lyrics || !lyrics.synced) return;
    const pos = estimatePosition();
    if (Number.isNaN(pos)) return;
    const lines = lyrics.synced;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].t <= pos + 0.15) idx = i; else break;
    }
    if (idx === activeIdx && !force) return;
    activeIdx = idx;
    const els = ui.list.querySelectorAll('.sml-line');
    els.forEach((el, i) => {
      el.classList.toggle('active', i === idx);
      el.classList.toggle('past', i < idx);
    });
    const el = els[idx];
    if (el && now() - userScrolledAt > 3000) {
      const list = ui.list;
      // Keep the current line a little below the top fade: about a quarter of the way down,
      // but never inside the faded strip.
      const compact = ui.panel.classList.contains('sml-compact');
      const fade = compact ? 14 : 28;
      const frac = compact ? 0.22 : 0.28;
      const desiredTop = Math.max(fade + 4, list.clientHeight * frac - el.clientHeight / 2);
      list.scrollTo({ top: Math.max(0, el.offsetTop - desiredTop), behavior: force ? 'auto' : 'smooth' });
    }
  }

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------
  function noteError(where, e) {
    const msg = `${where}: ${(e && e.stack) || e}`;
    if (msg !== lastError) console.warn(TAG, msg);
    lastError = msg;
  }

  function tick() {
    try { tickInner(); } catch (e) { noteError('tick', e); }
  }

  function tickInner() {
    if (!pip) return;
    if (pip.closed) { detachPip(); return; }

    try { layout(); } catch (e) { noteError('layout', e); }

    const track = getTrack();
    const key = track ? `${track.title}|${track.artist}` : null;
    if (key !== currentKey) {
      currentKey = key;
      fetchSeq++;
      clearTimeout(retryTimer);
      lyrics = null;
      activeIdx = -1;
      lastRawPos = NaN;
      pendingTrack = track;
      pendingSince = now();
      render();
    }

    if (pendingTrack) {
      const { dur } = getPlayback();
      if (dur > 0 || now() - pendingSince > 2500) {
        const t = pendingTrack;
        pendingTrack = null;
        loadLyrics(t, dur > 0 ? dur : 0, pendingSince);
      }
    }

    updateActive(false);
  }

  function attachPip(win) {
    if (!win || win === pip) return;
    console.info(TAG, 'miniplayer detected, injecting lyrics UI');
    pip = win;
    currentKey = null;
    shown = false;
    art = null;
    mode = 'body';
    buildUI(win);
    win.addEventListener('pagehide', () => { if (pip === win) detachPip(); });
    win.addEventListener('resize', () => layout());
  }

  function detachPip() {
    pip = null;
    ui = null;
    art = null;
    shiftedRow = null;
    rowShift = 0;
    shown = false;
    pendingTrack = null;
    clearTimeout(retryTimer);
  }

  loadSettings();
  pingBridge();

  if ('documentPictureInPicture' in window) {
    try {
      window.documentPictureInPicture.addEventListener('enter', (e) => attachPip(e.window));
    } catch (_) { /* ignore */ }
    setInterval(() => {
      try {
        const w = window.documentPictureInPicture.window;
        if (w && w !== pip) attachPip(w);
      } catch (_) { /* ignore */ }
    }, 1000);
    setInterval(tick, TICK_MS);
    console.info(TAG, 'ready — open the Spotify miniplayer to see the lyrics button');
  } else {
    console.info(TAG, 'Document Picture-in-Picture is not available in this browser; nothing to do.');
  }
})();
