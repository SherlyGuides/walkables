// Client for the Walkable link service (api/server.mjs).
let token = null;
export async function session() {
  const r = await fetch('/api/session'); if (!r.ok) throw new Error('No workspace session. Open this page from the machine the server runs on.');
  token = (await r.json()).token; return token;
}
export function getToken() { return token; }
export async function api(method, path, body, headers = {}) {
  const h = { ...headers }; if (token) h['x-workspace'] = token; if (body !== undefined && !(body instanceof Blob)) { h['content-type'] = 'application/json'; body = JSON.stringify(body); }
  const r = await fetch(path, { method, headers: h, body }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) { const e = new Error(json.error || r.statusText); e.status = r.status; e.body = json; throw e; }
  return json;
}
export function upload(path, blob, onProgress) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest(); x.open('PUT', path); if (token) x.setRequestHeader('x-workspace', token); x.setRequestHeader('content-type', blob.type || 'application/octet-stream');
    x.upload.onprogress = e => { if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => { let j = null; try { j = JSON.parse(x.responseText); } catch { j = {}; } if (x.status >= 200 && x.status < 300) res(j); else rej(new Error(j.error || x.statusText)); };
    x.onerror = () => rej(new Error('Upload failed')); x.send(blob);
  });
}
export function fileUrl(sceneId, name) { return `/api/scenes/${sceneId}/files/${name}?t=${encodeURIComponent(token || '')}`; }
export function fmtBytes(n) { if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(0) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }
export function fmtDate(ts) { return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
export function toast(msg, ms = 3000) { let t = document.querySelector('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); } t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms); }

export const ic = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="${window.WALKABLE_ICONS ?? '/assets/icons.svg'}#${name}"/></svg>`;
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Replaces confirm(): resolves true when the action is chosen.
export function confirmDialog({ title, body = '', action = 'Confirm', danger = false }) {
  return new Promise((res) => {
    const s = document.createElement('div'); s.className = 'scrim'; s.innerHTML = `<div class="pop dialog" role="dialog" aria-modal="true"><div class="heading"></div><p class="help"></p><div class="actions"><button class="ghost" data-x>Cancel</button><button class="${danger ? 'primary' : 'primary'}" data-ok></button></div></div>`;
    s.querySelector('.heading').textContent = title; s.querySelector('.help').textContent = body; const ok = s.querySelector('[data-ok]'); ok.textContent = action; if (danger) ok.style.cssText = 'background:var(--danger);border-color:var(--danger);color:#fff';
    const done = (v) => { s.remove(); removeEventListener('keydown', key); res(v); }; const key = (e) => { if (e.key === 'Escape') done(false); if (e.key === 'Enter') done(true); };
    s.onclick = (e) => { if (e.target === s) done(false); }; s.querySelector('[data-x]').onclick = () => done(false); ok.onclick = () => done(true); addEventListener('keydown', key); document.body.appendChild(s); ok.focus();
  });
}
// A small floating card with a real progress bar for uploads.
export function progressCard(label) {
  const el = document.createElement('div'); el.className = 'pop'; el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);width:320px;max-width:calc(100% - 32px);padding:14px 16px;display:grid;gap:10px;z-index:50;animation:rise 200ms var(--ease)';
  el.innerHTML = `<div class="spread small"><span class="lbl"></span><span class="mut pct">0%</span></div><div class="progress"><span></span></div>`; el.querySelector('.lbl').textContent = label; document.body.appendChild(el);
  return { set(p) { el.querySelector('.progress span').style.width = Math.round(p * 100) + '%'; el.querySelector('.pct').textContent = Math.round(p * 100) + '%'; }, label(t) { el.querySelector('.lbl').textContent = t; }, done() { el.remove(); } };
}
