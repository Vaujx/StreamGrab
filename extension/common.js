// Shared by every page. Loaded in <head> so the theme is applied before first paint.
(function () {
  try { const t = localStorage.getItem('theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) {}
})();

const Theme = {
  get() { try { return localStorage.getItem('theme') || 'system'; } catch { return 'system'; } },
  set(v) {
    try { v === 'system' ? localStorage.removeItem('theme') : localStorage.setItem('theme', v); } catch {}
    if (v === 'light' || v === 'dark') document.documentElement.dataset.theme = v;
    else delete document.documentElement.dataset.theme;
  },
  effective() {
    return document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  },
  toggle() { this.set(this.effective() === 'dark' ? 'light' : 'dark'); }
};

const MAX_ANIM_BYTES = 5 * 1024 * 1024;
const Store = {
  async getGif() { return (await chrome.storage.local.get('loadingGif')).loadingGif || null; },
  async setGif(file) {
    if (!file.type.startsWith('image/')) throw new Error('Please choose an image file (GIF, WebP or PNG).');
    if (file.size > MAX_ANIM_BYTES) throw new Error('That file is over 5 MB. Choose a smaller animation.');
    const url = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result); r.onerror = () => rej(new Error('Could not read the file.'));
      r.readAsDataURL(file);
    });
    await chrome.storage.local.set({ loadingGif: url });
    return url;
  },
  async clearGif() { await chrome.storage.local.remove('loadingGif'); },
  pickGif(accept = 'image/gif,image/webp,image/png,image/apng') {
    return new Promise((resolve) => {
      const i = document.createElement('input');
      i.type = 'file'; i.accept = accept;
      i.onchange = () => resolve(i.files[0] || null);
      i.click();
    });
  },
  async accepted() { return (await chrome.storage.local.get('termsAccepted')).termsAccepted || null; },
  async getSettings() { return { threads: 8, fmt: 'mp4', frameShow: true, frameFit: 'cover', ...((await chrome.storage.local.get('settings')).settings || {}) }; },
  async saveSettings(s) { await chrome.storage.local.set({ settings: s }); }
};

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-theme-toggle]').forEach(b => b.addEventListener('click', () => Theme.toggle()));
});

// ---- Picture frame: big images/GIFs (up to 30 MB) live in IndexedDB as Blobs ----
const MAX_FRAME_BYTES = 30 * 1024 * 1024;
const FrameDB = {
  _open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('streamgrab', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  async _run(mode, fn) {
    const db = await this._open();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', mode); let out;
      const req = fn(tx.objectStore('kv')); if (req) req.onsuccess = () => { out = req.result; };
      tx.oncomplete = () => { db.close(); res(out); }; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
  }
};
Store.getFrameUrl = async () => {
  const blob = await FrameDB._run('readonly', s => s.get('frame'));
  return blob ? URL.createObjectURL(blob) : null;
};
Store.setFrame = async (file) => {
  if (!file.type.startsWith('image/')) throw new Error('Please choose an image or GIF.');
  if (file.size > MAX_FRAME_BYTES) throw new Error('That file is over 30 MB. Choose a smaller one.');
  await FrameDB._run('readwrite', s => s.put(new Blob([file], { type: file.type }), 'frame'));
};
Store.clearFrame = () => FrameDB._run('readwrite', s => s.delete('frame'));
