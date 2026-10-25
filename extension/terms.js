const $ = (id) => document.getElementById(id);
async function refresh() {
  const acc = await Store.accepted();
  $('accept').hidden = !!acc; $('done').hidden = !acc;
  if (acc) $('when').textContent = 'You accepted these terms on ' + new Date(acc).toLocaleString() + '.';
}
$('agree').onchange = () => { $('ok').disabled = !$('agree').checked; };
$('ok').onclick = async () => { await chrome.storage.local.set({ termsAccepted: new Date().toISOString() }); refresh(); };
$('revoke').onclick = async () => { await chrome.storage.local.remove('termsAccepted'); $('agree').checked = false; $('ok').disabled = true; refresh(); };
refresh();
