# Spotify Miniplayer Lyrics

A small Chrome/Edge extension that adds a **lyrics button to the Spotify web player's miniplayer**
(the picture‑in‑picture window you get from the miniplayer button in the bottom‑right of open.spotify.com).

## Lyrics sources

Tried in this order; the credit line at the bottom of the panel says which one was used.

1. **Spotify's own lyrics** (default on). The web player already loads lyrics for your account whenever
   its lyrics panel or now‑playing sidebar is open; the extension copies those responses. If the page
   hasn't loaded lyrics for the current track, the extension asks Spotify for them using the same
   session the page uses. Best coverage, line‑synced. This uses Spotify's internal lyrics endpoint, the
   same way the Spicetify project does.
2. **[LRCLIB](https://lrclib.net)** – free, open database with time‑synced lyrics.
3. **NetEase Cloud Music** (default off, enable in the extension's options). Goes through a community
   proxy server, so song titles/artists you play are sent to a third party. Good coverage of Asian music.
4. **[lyrics.ovh](https://lyrics.ovh)** – plain (unsynced) lyrics as a last resort.

## Features

- Mic button in the top‑right corner of the miniplayer (or press **L** while the miniplayer is focused).
- Time‑synced lyrics that highlight and auto‑scroll with the song. Plain lyrics as a fallback.
- Click a line to jump to it (best effort, simulates a click on Spotify's progress bar).
- Replaces the album art with the lyrics, layered beneath Spotify's own hover controls so play/pause/skip
  stay visible and clickable.
- Hides itself when the window is too short to show a couple of lines; the artwork comes back.
- Lyrics are cached locally so repeat plays do not hit any API again.

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top‑right).
3. Click **Load unpacked** and pick this `SpotifyMiniLyrics` folder.
4. Reload the open.spotify.com tab.
5. Click Spotify's **miniplayer** button (bottom‑right of the player bar). A mic icon appears in the
   top‑right of the miniplayer window. Click it.

Settings (enable NetEase, disable Spotify source): right‑click the extension icon → **Options**.

Only Chromium browsers (Chrome, Edge, Brave, Arc…) have the Document Picture‑in‑Picture API that the
Spotify miniplayer is built on, so this does not apply to Firefox or Safari.

## Files

- `manifest.json` – Manifest V3; runs only on open.spotify.com.
- `bridge.js` – runs in the page's own JS world. Watches the web player's network calls for lyrics
  responses and remembers the auth headers the page uses, so the extension can request lyrics for the
  current track. The token never leaves the page except to Spotify itself.
- `content.js` – detects the miniplayer, reads track info and playback position from the player bar,
  runs the provider chain, renders the panel.
- `options.html` / `options.js` – source toggles.

## Privacy

- Spotify source: only talks to Spotify, with your own session.
- LRCLIB / lyrics.ovh / NetEase proxy: receive the title, artist (and album/duration) of what you play.
- Nothing else is collected or sent anywhere. No analytics, no remote code.

## Tweaks

- `MIN_PANEL_HEIGHT` in `content.js` is the window height (px) below which the lyrics hide themselves.
- `CONTROLS_GAP_PX` only matters in the fallback mode used when no artwork element can be found.
- If the lyrics ever appear *over* Spotify's controls, open the miniplayer's DevTools console: the
  extension logs which layout mode it chose (`body`, `stage` or `top`).

## Known limitations

- Spotify's DOM `data-testid` names and internal lyrics endpoint can change without notice.
- Spotify's lyrics endpoint is internal; using it is the same gray area Spicetify operates in.
- Seeking by clicking a line depends on the main tab's progress bar being laid out.
