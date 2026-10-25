const listEl = document.getElementById('list');
const countEl = document.getElementById('count');
const fmtSize = (n) => !n ? '' : n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : (n / 1e6).toFixed(1) + ' MB';

async function render() {
  if (!(await Store.accepted())) document.getElementById('notice').hidden = false;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const key = 'tab:' + tab.id;
  const list = (await chrome.storage.session.get(key))[key] || [];
  countEl.textContent = list.length ? ' · ' + list.length + ' found' : '';
  listEl.innerHTML = '';
  if (!list.length) {
    const gif = await Store.getGif();
    const e = document.createElement('div');
    e.className = 'empty';
    e.innerHTML = (gif ? '<img class="waiting" alt="">' : '<span class="pulse"></span>') +
      '<strong>Waiting for media</strong><span class="muted">Press play on a video, then reopen this popup.</span>';
    if (gif) e.querySelector('img').src = gif;
    listEl.appendChild(e);
    return;
  }
  for (const item of list.slice().reverse()) {
    const u = new URL(item.url);
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span class="tag ${item.type}">${item.type === 'hls' ? 'HLS' : 'File'}</span>
      <div class="info"><div class="name"></div><div class="muted small"></div></div>
      <button class="btn primary">Download</button>`;
    row.querySelector('.name').textContent = u.pathname.split('/').pop() || u.hostname;
    row.querySelector('.name').title = item.url;
    row.querySelector('.small').textContent = [u.hostname, fmtSize(item.size)].filter(Boolean).join(' · ');
    row.querySelector('button').onclick = () => {
      const q = new URLSearchParams({ url: item.url, type: item.type, ref: item.pageUrl, title: item.title });
      chrome.tabs.create({ url: chrome.runtime.getURL('downloader.html?' + q) });
    };
    listEl.appendChild(row);
  }
}
render();
