const DEFAULTS = { spotify: true, netease: false, preferLatin: true };
const KEY = 'sml:settings';

const boxes = {
  spotify: document.getElementById('spotify'),
  netease: document.getElementById('netease'),
  preferLatin: document.getElementById('preferLatin'),
};

chrome.storage.local.get(KEY, (r) => {
  const s = { ...DEFAULTS, ...((r && r[KEY]) || {}) };
  for (const k of Object.keys(boxes)) boxes[k].checked = !!s[k];
});

const debugBox = document.getElementById('debug');
function loadDebug() {
  chrome.storage.local.get('sml:debug', (r) => {
    debugBox.value = (r && r['sml:debug']) || '(no snapshot yet: open the miniplayer, turn lyrics on, wait 3 s, then click Refresh)';
  });
}
loadDebug();
document.getElementById('refresh').addEventListener('click', loadDebug);
document.getElementById('copy').addEventListener('click', async () => {
  const note = document.getElementById('copied');
  try {
    await navigator.clipboard.writeText(debugBox.value);
    note.textContent = 'Copied';
  } catch (_) {
    debugBox.select();
    document.execCommand('copy');
    note.textContent = 'Copied';
  }
  setTimeout(() => { note.textContent = ''; }, 1500);
});

for (const k of Object.keys(boxes)) {
  boxes[k].addEventListener('change', () => {
    const s = {};
    for (const j of Object.keys(boxes)) s[j] = boxes[j].checked;
    chrome.storage.local.set({ [KEY]: s }, () => {
      const el = document.getElementById('saved');
      el.textContent = 'Saved';
      setTimeout(() => { el.textContent = ''; }, 1200);
    });
  });
}
