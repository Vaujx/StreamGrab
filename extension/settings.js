const $ = (id) => document.getElementById(id);
const say = (t, cls = '') => { $('msg').textContent = t; $('msg').className = cls; };
const sayFrame = (t, ok) => { $('frameMsg').textContent = t; $('frameMsg').style.color = ok ? 'var(--ok)' : 'var(--err)'; };
let cur = {};
const persist = () => Store.saveSettings(cur);

function markTheme() {
  const t = Theme.get();
  document.querySelectorAll('#themeSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === t)));
}
document.querySelectorAll('#themeSeg button').forEach(b => b.onclick = () => { Theme.set(b.dataset.v); markTheme(); });
document.querySelectorAll('[data-theme-toggle]').forEach(b => b.addEventListener('click', markTheme));
markTheme();

// Loading animation
async function showPreview() {
  const gif = await Store.getGif();
  $('preview').innerHTML = gif ? '<img alt="Your loading animation">' : '<span class="spin"></span>';
  if (gif) $('preview').querySelector('img').src = gif;
  $('resetGif').disabled = !gif;
}
$('importGif').onclick = async () => {
  const file = await Store.pickGif();
  if (!file) return;
  try { await Store.setGif(file); say('Animation saved.', 'ok'); await showPreview(); }
  catch (e) { say(e.message, 'err'); }
};
$('resetGif').onclick = async () => { await Store.clearGif(); say('Back to the default animation.', 'ok'); showPreview(); };
showPreview();

// Picture frame
async function showFrame() {
  const url = await Store.getFrameUrl();
  $('framePreview').innerHTML = url ? '<img alt="Your framed picture">' : '<span class="muted small">No picture</span>';
  if (url) $('framePreview').querySelector('img').src = url;
  $('removeFrame').disabled = !url;
}
$('importFrame').onclick = async () => {
  const file = await Store.pickGif('image/*');
  if (!file) return;
  try { await Store.setFrame(file); sayFrame('Picture saved.', true); await showFrame(); }
  catch (e) { sayFrame(e.message, false); }
};
$('removeFrame').onclick = async () => { await Store.clearFrame(); sayFrame('Picture removed.', true); showFrame(); };
function markFit() {
  document.querySelectorAll('#fitSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === cur.frameFit)));
  $('framePreview').style.setProperty('--fit', cur.frameFit);
  const img = $('framePreview').querySelector('img'); if (img) img.style.objectFit = cur.frameFit;
}
document.querySelectorAll('#fitSeg button').forEach(b => b.onclick = () => { cur.frameFit = b.dataset.v; persist(); markFit(); });
$('frameShow').onchange = () => { cur.frameShow = $('frameShow').checked; persist(); };

(async () => {
  cur = await Store.getSettings();
  $('dThreads').value = String(cur.threads); $('dFmt').value = cur.fmt; $('frameShow').checked = cur.frameShow;
  $('dThreads').onchange = () => { cur.threads = +$('dThreads').value; persist(); };
  $('dFmt').onchange = () => { cur.fmt = $('dFmt').value; persist(); };
  await showFrame(); markFit();
  $('importFrame').addEventListener('click', () => setTimeout(markFit, 300));
  const acc = await Store.accepted();
  $('legal').textContent = acc ? 'Terms accepted on ' + new Date(acc).toLocaleDateString() + '.' : 'You have not accepted the terms yet.';
})();
