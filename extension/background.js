// Detects media requests per tab and keeps a list in session storage.
const HLS_TYPES = ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'];
const MIN_DIRECT_SIZE = 200 * 1024; // ignore tiny clips/ads pings

function classify(url, contentType, size) {
  const path = url.split('?')[0].toLowerCase();
  const ct = (contentType || '').toLowerCase().split(';')[0].trim();
  if (path.endsWith('.m3u8') || HLS_TYPES.includes(ct)) return 'hls';
  if (ct === 'video/mp2t' || path.endsWith('.ts') || path.endsWith('.m4s')) return null; // segments
  if (/\.(mp4|webm|m4a|mp3|mov|mkv)$/.test(path) || ct.startsWith('video/') || ct.startsWith('audio/')) {
    if (size && size < MIN_DIRECT_SIZE) return null;
    return 'file';
  }
  return null;
}

async function addItem(tabId, item) {
  const key = 'tab:' + tabId;
  const data = await chrome.storage.session.get(key);
  const list = data[key] || [];
  if (list.some(i => i.url === item.url)) return;
  list.push(item);
  await chrome.storage.session.set({ [key]: list });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#2fbf8a' });
  chrome.action.setBadgeText({ tabId, text: String(list.length) });
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0) return;
    if (d.statusCode !== 200 && d.statusCode !== 206) return;
    const h = Object.fromEntries((d.responseHeaders || []).map(x => [x.name.toLowerCase(), x.value]));
    let size = parseInt(h['content-length'] || '0', 10);
    const range = h['content-range'];
    if (range && range.includes('/')) size = parseInt(range.split('/')[1], 10) || size;
    const type = classify(d.url, h['content-type'], size);
    if (!type) return;
    chrome.tabs.get(d.tabId).then(tab => {
      addItem(d.tabId, {
        url: d.url, type, size, time: Date.now(),
        pageUrl: tab.url || '', title: tab.title || ''
      });
    }).catch(() => {});
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// Reset the list when the tab navigates to a new page
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) {
    chrome.storage.session.remove('tab:' + tabId);
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove('tab:' + tabId));

// Open the terms page on first install
chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('terms.html') });
});
