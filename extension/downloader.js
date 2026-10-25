const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const srcUrl = params.get('url');
const type = params.get('type');
const pageRef = params.get('ref') || '';
const pageTitle = params.get('title') || '';

let variants = [];       // master playlist variants
let stopRequested = false;
let running = false;

const sanitize = (s) => (s || 'video').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'video';
const setState = (v) => { $('stage').dataset.state = v; };
const setStatus = (t, cls = '') => { $('status').textContent = t; $('status').className = cls; };
const fmtBytes = (n) => n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : (n / 1e3).toFixed(0) + ' KB';

// ---- Make requests look like they come from the original page (Referer / Origin) ----
async function applyHeaderRules() {
  if (!pageRef) return;
  const tab = await chrome.tabs.getCurrent();
  let origin = '';
  try { origin = new URL(pageRef).origin; } catch {}
  const ruleId = 1000 + (tab?.id % 100000);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [{
      id: ruleId, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [
        { header: 'referer', operation: 'set', value: pageRef },
        ...(origin ? [{ header: 'origin', operation: 'set', value: origin }] : [])
      ] },
      condition: { tabIds: [tab.id], resourceTypes: ['xmlhttprequest', 'other'] }
    }]
  });
}

// ---- Playlist parsing ----
function parseAttrs(s) {
  const out = {}; const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g; let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}
const abs = (u, base) => new URL(u, base).href;

function parsePlaylist(text, base) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('Not a valid m3u8 playlist.');
  if (lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))) {
    const vs = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
        const a = parseAttrs(lines[i].slice(18));
        const next = lines.slice(i + 1).find(l => !l.startsWith('#'));
        if (next) vs.push({ url: abs(next, base), bandwidth: +a.BANDWIDTH || 0, res: a.RESOLUTION || '' });
      }
    }
    return { master: true, variants: vs.sort((a, b) => b.bandwidth - a.bandwidth) };
  }
  const r = { master: false, segments: [], encrypted: false, map: null, live: true, targetDuration: 6 };
  let dur = 0;
  for (const l of lines) {
    if (l.startsWith('#EXT-X-KEY:')) { if (parseAttrs(l.slice(11)).METHOD !== 'NONE') r.encrypted = true; }
    else if (l.startsWith('#EXT-X-MAP:')) r.map = abs(parseAttrs(l.slice(11)).URI, base);
    else if (l.startsWith('#EXT-X-TARGETDURATION:')) r.targetDuration = +l.split(':')[1] || 6;
    else if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8));
    else if (l === '#EXT-X-ENDLIST') r.live = false;
    else if (!l.startsWith('#')) { r.segments.push({ url: abs(l, base), dur }); dur = 0; }
  }
  return r;
}

async function getText(url) {
  const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for playlist`);
  return res.text();
}

async function fetchBuf(url, tries = 4) {
  for (let t = 1; ; t++) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.arrayBuffer();
    } catch (e) {
      if (t >= tries || stopRequested) throw e;
      await new Promise(r => setTimeout(r, 500 * t));
    }
  }
}

// ---- Download engine ----
const progress = { done: 0, total: 0, bytes: 0, t0: 0 };
function updateProgress() {
  $('fill').style.width = progress.total ? (100 * progress.done / progress.total).toFixed(1) + '%' : '0';
  $('prog').textContent = `${progress.done} / ${progress.total || '?'} segments · ${fmtBytes(progress.bytes)}`;
  const secs = (Date.now() - progress.t0) / 1000;
  $('speed').textContent = secs > 1 ? fmtBytes(progress.bytes / secs) + '/s' : '';
}

async function downloadSegments(segs, threads, store, offset = 0) {
  let next = 0;
  async function worker() {
    while (!stopRequested) {
      const i = next++;
      if (i >= segs.length) return;
      const buf = await fetchBuf(segs[i].url);
      store[offset + i] = buf;
      progress.done++; progress.bytes += buf.byteLength; updateProgress();
    }
  }
  await Promise.all(Array.from({ length: threads }, worker));
}

function saveBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

function toMp4(buffers) {
  return new Promise((resolve, reject) => {
    const tx = new muxjs.mp4.Transmuxer();
    const parts = []; let gotInit = false;
    tx.on('data', (seg) => {
      if (!gotInit) { parts.push(seg.initSegment); gotInit = true; }
      parts.push(seg.data);
    });
    tx.on('error', reject);
    try {
      buffers.forEach(b => { tx.push(new Uint8Array(b)); tx.flush(); });
    } catch (e) { return reject(e); }
    if (!gotInit) return reject(new Error('Conversion produced no output (unsupported stream codecs?).'));
    resolve(new Blob(parts, { type: 'video/mp4' }));
  });
}

async function finalize(buffers, isFmp4, name) {
  const wanted = $('fmt').value;
  const clean = buffers.filter(Boolean);
  if (!clean.length) throw new Error('Nothing was downloaded.');
  if (isFmp4) { saveBlob(new Blob(clean, { type: 'video/mp4' }), name + '.mp4'); return; }
  if (wanted === 'ts') { saveBlob(new Blob(clean, { type: 'video/mp2t' }), name + '.ts'); return; }
  setStatus('Converting to MP4…');
  try {
    saveBlob(await toMp4(clean), name + '.mp4');
  } catch (e) {
    console.warn(e);
    setStatus('Conversion failed, saving raw .ts instead.', 'err');
    saveBlob(new Blob(clean, { type: 'video/mp2t' }), name + '.ts');
    return;
  }
}

async function runHls() {
  running = true; stopRequested = false;
  $('start').disabled = true; $('stop').disabled = false; setState('busy');
  const name = sanitize($('name').value);
  const threads = +$('threads').value;
  const mediaUrl = variants.length ? variants[$('quality').selectedIndex].url : srcUrl;
  try {
    let pl = parsePlaylist(await getText(mediaUrl), mediaUrl);
    if (pl.encrypted) throw new Error('This stream is encrypted. Encrypted streams are not supported.');
    const buffers = [];
    progress.done = 0; progress.bytes = 0; progress.t0 = Date.now();
    const isFmp4 = !!pl.map;
    if (isFmp4) buffers.push(await fetchBuf(pl.map));

    if (!pl.live) {
      progress.total = pl.segments.length; updateProgress();
      setStatus('Downloading…');
      const store = [];
      await downloadSegments(pl.segments, threads, store);
      await finalize(buffers.concat(store), isFmp4, name);
    } else {
      // Live: poll the playlist and grab new segments until the user stops or the stream ends.
      setStatus('Recording live stream… press “Stop & save” to finish.');
      const seen = new Set(); const store = [];
      while (!stopRequested) {
        const fresh = pl.segments.filter(s => !seen.has(s.url));
        fresh.forEach(s => seen.add(s.url));
        progress.total += fresh.length; updateProgress();
        await downloadSegments(fresh, threads, store, store.length);
        if (!pl.live) break;
        await new Promise(r => setTimeout(r, Math.max(1000, pl.targetDuration * 500)));
        if (stopRequested) break;
        try { pl = parsePlaylist(await getText(mediaUrl), mediaUrl); } catch { break; }
      }
      await finalize(buffers.concat(store), isFmp4, name);
    }
    setStatus(stopRequested ? 'Stopped. Partial file saved.' : 'Done. File saved.', 'ok');
  } catch (e) {
    setStatus(e.message || String(e), 'err');
  } finally {
    running = false; $('start').disabled = false; $('stop').disabled = true; setState($('status').className === 'ok' ? 'done' : 'idle');
  }
}

async function runDirect() {
  running = true; stopRequested = false;
  $('start').disabled = true; $('stop').disabled = false; setState('busy');
  const name = sanitize($('name').value);
  try {
    setStatus('Connecting…');
    const res = await fetch(srcUrl, { credentials: 'include' });
    if (!res.ok) throw new Error(`The site refused the request (HTTP ${res.status}). The link may have expired: reload the page, press play, and pick the new entry.`);
    const total = +res.headers.get('content-length') || 0;
    const ct = (res.headers.get('content-type') || '').split(';')[0];
    const urlExt = (new URL(srcUrl).pathname.match(/\.(\w{2,4})$/) || [])[1];
    const ext = urlExt || (ct.includes('webm') ? 'webm' : ct.startsWith('audio/') ? 'mp3' : 'mp4');
    const reader = res.body.getReader();
    const chunks = []; progress.bytes = 0; progress.t0 = Date.now();
    setStatus('Downloading…');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); progress.bytes += value.length;
      $('fill').style.width = total ? (100 * progress.bytes / total).toFixed(1) + '%' : '0';
      $('prog').textContent = fmtBytes(progress.bytes) + (total ? ' / ' + fmtBytes(total) : '');
      const secs = (Date.now() - progress.t0) / 1000;
      $('speed').textContent = secs > 1 ? fmtBytes(progress.bytes / secs) + '/s' : '';
      if (stopRequested) { await reader.cancel(); break; }
    }
    saveBlob(new Blob(chunks, { type: ct || 'video/mp4' }), name + '.' + ext);
    setStatus(stopRequested ? 'Stopped. Partial file saved.' : 'Done. File saved.', 'ok');
  } catch (e) {
    setStatus(e.message || String(e), 'err');
  } finally {
    running = false; $('start').disabled = false; $('stop').disabled = true; setState($('status').className === 'ok' ? 'done' : 'idle');
  }
}

async function initFrame() {
  const st = await Store.getSettings();
  if (!st.frameShow) { $('frameCol').hidden = true; $('layout').dataset.noframe = '1'; return; }
  $('frame').dataset.fit = st.frameFit;
  const msg = (t) => { $('frameMsg').textContent = t || ''; };
  const show = (url) => {
    const has = !!url;
    $('frameImg').hidden = !has; $('frameCtl').hidden = !has; $('frameAdd').hidden = has;
    if (has) $('frameImg').src = url; else $('frameImg').removeAttribute('src');
  };
  const pick = async () => {
    const file = await Store.pickGif('image/*');
    if (!file) return;
    try { await Store.setFrame(file); msg(''); show(await Store.getFrameUrl()); }
    catch (e) { msg(e.message); }
  };
  $('frameAdd').onclick = pick; $('frameChange').onclick = pick;
  $('frameRemove').onclick = async () => { await Store.clearFrame(); msg(''); show(null); };
  show(await Store.getFrameUrl());
}

function guard(fn) {
  return async () => {
    if (!(await Store.accepted())) { $('notice').hidden = false; return; }
    $('notice').hidden = true; fn();
  };
}

async function init() {
  const st = await Store.getSettings();
  $('threads').value = String(st.threads); $('fmt').value = st.fmt;
  const gif = await Store.getGif();
  if (gif) { document.querySelector('#anim .custom').src = gif; $('anim').dataset.gif = '1'; }
  $('title').textContent = pageTitle || 'Save media';
  initFrame();
  if (!(await Store.accepted())) $('notice').hidden = false;
  $('src').textContent = srcUrl;
  $('name').value = sanitize(pageTitle);
  $('stop').onclick = () => { stopRequested = true; setStatus('Stopping…'); };
  await applyHeaderRules();
  if (type !== 'hls') {
    $('quality').innerHTML = '<option>Original</option>';
    $('threads').disabled = true; $('fmt').disabled = true;
    setStatus('Direct file. Ready.');
    $('start').disabled = false; $('start').onclick = guard(runDirect);
    return;
  }
  try {
    const pl = parsePlaylist(await getText(srcUrl), srcUrl);
    if (pl.master) {
      variants = pl.variants;
      $('quality').innerHTML = '';
      variants.forEach(v => {
        const o = document.createElement('option');
        o.textContent = `${v.res || 'unknown size'} · ${(v.bandwidth / 1e6).toFixed(2)} Mbps`;
        $('quality').appendChild(o);
      });
      $('quality').disabled = false;
      setStatus(`${variants.length} qualities found. Pick one and start.`);
    } else {
      $('quality').innerHTML = '<option>Single quality</option>';
      if (pl.encrypted) { setStatus('This stream is encrypted. Encrypted streams are not supported.', 'err'); return; }
      setStatus(pl.live ? 'Live stream detected. Ready to record.' : `${pl.segments.length} segments. Ready.`);
    }
    $('start').disabled = false; $('start').onclick = guard(runHls);
  } catch (e) { setStatus(e.message, 'err'); }
}
init();
