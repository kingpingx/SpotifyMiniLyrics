# Spotify Miniplayer Lyrics

**Synced lyrics inside the Spotify web player's miniplayer.**

Spotify's web player has a handy picture-in-picture miniplayer, but no lyrics in it. This Chrome/Edge
extension adds a mic button to that window. Click it and the album art is replaced by time-synced lyrics
that highlight and scroll with the song, while Spotify's own play/pause/skip controls and seek bar keep
working on top.

## Features

- **Mic button** in the miniplayer (or press `L` while the miniplayer is focused).
- **Time-synced lyrics**: the current line is highlighted and kept in view. Plain lyrics when sync isn't available.
- **Lyrics replace the artwork** rather than covering it, layered beneath Spotify's hover controls.
  The control row is nudged down next to the seek bar so it never sits on the current line.
- **Scroll and click through** Spotify's overlay: wheel to browse the lyrics, click a line to jump to it.
- **Adapts to window size**: a compact style for small windows, and the panel hides itself (artwork comes
  back) when the window is too short to show a couple of lines.
- **Four lyric sources**, with the one used shown at the bottom of the panel.
- **Local cache** so a song is looked up once.

## Lyric sources

Tried in this order:

1. **Spotify's own lyrics** (default on). Always used when Spotify has them, synced or not. The web player
   loads lyrics for your account whenever its lyrics panel or now-playing sidebar is open; the extension
   reuses those responses. If the page hasn't loaded lyrics for the current track, it asks Spotify using the
   same session the page uses. Best coverage, line-synced. This uses Spotify's internal lyrics endpoint, the
   same way the Spicetify project does.
2. **[LRCLIB](https://lrclib.net)**: free, open, community lyrics database with synced lyrics.
3. **NetEase Cloud Music** (default **off**; enable in Options). Goes through a community-run proxy server,
   so titles/artists of songs you play are sent to a third party. Good coverage of Asian music.
4. **[lyrics.ovh](https://lyrics.ovh)**: plain (unsynced) lyrics as a last resort.

## Install

The extension is not on the Chrome Web Store; load it unpacked.

1. Clone or download this repository.
2. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the repository folder.
4. Reload any open `open.spotify.com` tab.
5. Click Spotify's **miniplayer** button (bottom right of the player bar). A mic icon appears in the
   top right of the miniplayer. Click it.

**Options** (right-click the extension icon → Options): toggle the Spotify and NetEase sources, and view
the debug snapshot (see Troubleshooting).

Only Chromium browsers (Chrome, Edge, Brave, Arc, …) have the Document Picture-in-Picture API that the
Spotify miniplayer is built on, so this does not apply to Firefox or Safari.

## Privacy

- **Spotify source**: talks only to Spotify, with your own session. The session headers are kept in memory
  in the page and never stored or sent anywhere else.
- **LRCLIB / lyrics.ovh / NetEase proxy**: receive the title, artist and (for LRCLIB) album and duration of
  what you play. Nothing else.
- **Stored locally**: fetched lyrics (cache), your two option toggles, and the debug snapshot.
- No analytics, no accounts, no remote code. Everything is in this repository.

## How it works

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3. Runs only on `open.spotify.com`. |
| `content.js` | Detects the miniplayer window via `documentPictureInPicture`, injects the button and panel, reads track info and playback position from the player bar, runs the provider chain, renders and syncs the lyrics. |
| `bridge.js` | Runs in the page's own JS world. Watches the web player's network calls for lyrics responses and remembers the auth headers the page uses, so the extension can request lyrics for the current track. |
| `options.html` / `options.js` | Source toggles and the debug snapshot viewer. |

Layout: when lyrics are on, the artwork element is hidden and the panel is placed exactly where it was,
in a lower layer than Spotify's hover controls. A periodic check confirms nothing opaque is covering the
panel and moves it up a layer if needed.

## Troubleshooting

- **"No lyrics found" with a grey line underneath**: that line says what each source returned
  (e.g. `spotify: none · lrclib: rate-limited · ovh: none`). `rate-limited` means LRCLIB is throttling your
  IP; it retries automatically.
- **Lyrics never say "via Spotify"**: open the main Spotify tab's lyrics panel once, or check the Options
  page is set to use the Spotify source.
- **Layout looks wrong**: open Options → Debug. A snapshot of the miniplayer's structure is taken 3 s after
  you turn lyrics on (or press `D` in the miniplayer). Paste it into an issue.
- Spotify's DOM and internal endpoints can change without notice. If the position stops tracking, the
  selectors in `getPlayback()` in `content.js` are the first place to look.

## Tweaks

- `MIN_ART_HEIGHT` in `content.js`: artwork height (px) below which lyrics hide themselves.
- `COMPACT_HEIGHT`: panel height below which the compact style is used.
- Colours and sizes live in the `CSS` string in `content.js`.

## Credits

Lyrics data from [LRCLIB](https://lrclib.net), [lyrics.ovh](https://lyrics.ovh), NetEase Cloud Music and
Spotify. Inspired by Spicetify's Lyrics Plus.

## License

[MIT](LICENSE)
