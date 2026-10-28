// Spotify Miniplayer Lyrics – page bridge (runs in the page's own JS world).
//
// Two jobs:
//  1. Passively watch the web player's own network calls. When it fetches lyrics
//     for a track (it does this whenever the lyrics panel / now-playing sidebar is
//     open) we copy the response and hand it to the extension. No extra requests.
//  2. Remember the auth headers the web player attaches to its own API calls so
//     the extension can ask for lyrics of the current track when the page hasn't
//     already fetched them. This reuses your logged-in session; it never sends
//     the token anywhere other than Spotify.
//
// Communication with the extension's content script is via window.postMessage
// restricted to this page's origin.

(() => {
  'use strict';

  const LYRICS_URL = /(?:spclient\.wg\.spotify\.com|[a-z0-9-]+-spclient\.spotify\.com)\/color-lyrics\/v2\/track\/([A-Za-z0-9]{22})/;
  const API_HOST = /(?:spclient|api(?:-partner)?\.spotify\.com)/;
  const KEEP = ['authorization', 'client-token', 'app-platform', 'spotify-app-version'];

  let authHeaders = null;

  function post(msg) {
    try { window.postMessage({ __sml: true, ...msg }, location.origin); } catch (_) { /* ignore */ }
  }

  function collectHeaders(input, init) {
    const out = {};
    const take = (h) => {
      if (!h) return;
      try {
        if (typeof Headers !== 'undefined' && h instanceof Headers) h.forEach((v, k) => { out[k.toLowerCase()] = v; });
        else if (Array.isArray(h)) for (const [k, v] of h) out[String(k).toLowerCase()] = v;
        else if (typeof h === 'object') for (const k of Object.keys(h)) out[k.toLowerCase()] = h[k];
      } catch (_) { /* ignore */ }
    };
    if (typeof Request !== 'undefined' && input instanceof Request) take(input.headers);
    if (init && init.headers) take(init.headers);
    return out;
  }

  function rememberAuth(url, h) {
    if (!h.authorization || !/^Bearer\s+\S+/i.test(h.authorization)) return;
    if (!API_HOST.test(url)) return;
    const next = {};
    for (const k of KEEP) if (h[k]) next[k] = h[k];
    authHeaders = next;
  }

  // ---- fetch hook ------------------------------------------------------------
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    let url = '';
    try { url = typeof input === 'string' ? input : (input && input.url) || String(input); } catch (_) { /* ignore */ }
    try { rememberAuth(url, collectHeaders(input, init)); } catch (_) { /* ignore */ }

    const p = origFetch.apply(this, arguments);
    const m = LYRICS_URL.exec(url);
    if (m) {
      p.then((res) => {
        if (!res || !res.ok) return;
        res.clone().json().then((data) => post({ type: 'lyrics', id: m[1], data })).catch(() => {});
      }).catch(() => {});
    }
    return p;
  };

  // ---- XHR hook ----------------------------------------------------------------
  const XP = XMLHttpRequest.prototype;
  const origOpen = XP.open, origSend = XP.send, origSetHeader = XP.setRequestHeader;
  XP.open = function (method, url) {
    this.__smlUrl = String(url);
    this.__smlHeaders = {};
    return origOpen.apply(this, arguments);
  };
  XP.setRequestHeader = function (k, v) {
    try { if (this.__smlHeaders) this.__smlHeaders[String(k).toLowerCase()] = v; } catch (_) { /* ignore */ }
    return origSetHeader.apply(this, arguments);
  };
  XP.send = function () {
    try { rememberAuth(this.__smlUrl || '', this.__smlHeaders || {}); } catch (_) { /* ignore */ }
    const m = LYRICS_URL.exec(this.__smlUrl || '');
    if (m) {
      this.addEventListener('load', () => {
        try { if (this.status === 200) post({ type: 'lyrics', id: m[1], data: JSON.parse(this.responseText) }); } catch (_) { /* ignore */ }
      });
    }
    return origSend.apply(this, arguments);
  };

  // ---- messages from the content script ---------------------------------------------
  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || e.data.__sml !== true) return;
    if (e.data.type === 'ping') { post({ type: 'bridge-ready', hasToken: !!authHeaders }); return; }
    if (e.data.type !== 'get-lyrics') return;
    const { id, reqId } = e.data;
    if (!authHeaders) { post({ type: 'lyrics-result', reqId, id, error: 'no-token' }); return; }
    try {
      const url = `https://spclient.wg.spotify.com/color-lyrics/v2/track/${id}?format=json&vocalRemoval=false&market=from_token`;
      const headers = { accept: 'application/json', 'app-platform': 'WebPlayer', ...authHeaders };
      const res = await origFetch(url, { headers });
      if (res.status === 404) { post({ type: 'lyrics-result', reqId, id, data: null }); return; }
      if (!res.ok) { post({ type: 'lyrics-result', reqId, id, error: 'HTTP ' + res.status }); return; }
      post({ type: 'lyrics-result', reqId, id, data: await res.json() });
    } catch (err) {
      post({ type: 'lyrics-result', reqId, id, error: String((err && err.message) || err) });
    }
  });

  post({ type: 'bridge-ready', hasToken: false });
})();
