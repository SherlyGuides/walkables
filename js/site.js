// walkable public site: navigation, reveal on scroll, section tracking, copy buttons, the early-access form,
// and the home-page drop zone that hands a GLB to the try page through IndexedDB.
(() => {
  const $ = (id) => document.getElementById(id);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // navigation
  const nav = $('nav');
  if (nav) { const onScroll = () => nav.classList.toggle('scrolled', scrollY > 8); addEventListener('scroll', onScroll, { passive: true }); onScroll(); }
  const menuBtn = $('menuBtn');
  if (menuBtn) {
    menuBtn.addEventListener('click', () => { const open = nav.classList.toggle('open'); menuBtn.setAttribute('aria-expanded', open); });
    document.addEventListener('click', (e) => { if (nav.classList.contains('open') && !nav.contains(e.target)) { nav.classList.remove('open'); menuBtn.setAttribute('aria-expanded', 'false'); } });
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && nav.classList.contains('open')) { nav.classList.remove('open'); menuBtn.setAttribute('aria-expanded', 'false'); menuBtn.focus(); } });
  }

  // reveal on scroll
  const reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !reduced) {
    const io = new IntersectionObserver((es) => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -10% 0px' });
    reveals.forEach(el => io.observe(el));
  } else reveals.forEach(el => el.classList.add('in'));

  // table of contents on long pages
  const toc = document.querySelector('.toc');
  if (toc && 'IntersectionObserver' in window) {
    const links = [...toc.querySelectorAll('a[href^="#"]')];
    const sections = links.map(a => document.getElementById(a.getAttribute('href').slice(1))).filter(Boolean);
    const io = new IntersectionObserver((es) => es.forEach(e => { if (e.isIntersecting) links.forEach(a => a.classList.toggle('cur', a.getAttribute('href') === '#' + e.target.id)); }), { rootMargin: '-15% 0px -75% 0px' });
    sections.forEach(s => io.observe(s));
  }

  // toast (ink, bottom centre, one line)
  function toast(msg, ms = 2600) { let t = document.querySelector('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); } t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms); }

  // copy buttons
  document.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied.'); } catch { toast(b.dataset.copy); } }));

  // early access: the host serves files only, so the form composes an email
  const form = $('eaForm');
  if (form) {
    const qs = new URLSearchParams(location.search); const model = qs.get('model'); if (model && form.notes && !form.notes.value) form.notes.value = 'I tried the try page with my model "' + model + '" and would like a link for it.'; const plan = form.querySelector('[name=plan]'); if (plan && qs.get('plan')) plan.value = qs.get('plan');
    form.addEventListener('submit', (e) => {
      e.preventDefault(); const d = new FormData(form);
      const lines = ['Hello walkable,', '', 'I would like early access.', '', 'Name: ' + d.get('name'), 'Practice: ' + (d.get('firm') || '-'), 'Email: ' + d.get('email'), 'We model in: ' + (d.get('tool') || '-'), 'Plan I am interested in: ' + (d.get('plan') || '-'), 'Typical project: ' + (d.get('project') || '-'), '', d.get('notes') ? String(d.get('notes')) : ''].join('\n');
      const subject = 'Early access: ' + (d.get('firm') || d.get('name'));
      $('eaDone').hidden = false; $('eaDone').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' });
      location.href = 'mailto:support@thinkpro.academy?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(lines);
    });
  }

  // home-page drop zone: stash the file for /try/ and go there
  const zone = document.querySelector('.dropzone[href]');
  if (zone) {
    const over = (on) => (e) => { e.preventDefault(); zone.classList.toggle('over', on); };
    zone.addEventListener('dragenter', over(true)); zone.addEventListener('dragover', over(true)); zone.addEventListener('dragleave', over(false));
    zone.addEventListener('drop', async (e) => {
      e.preventDefault(); zone.classList.remove('over'); const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (!f) return;
      if (!/\.(glb|gltf)$/i.test(f.name)) return toast('Drop a GLB file. Other formats need an export first.');
      try { await stash(f); } catch { return toast('Could not hand the file over. Open the try page and choose it there.'); }
      location.href = zone.getAttribute('href');
    });
  }
  function stash(file) {
    return new Promise((res, rej) => {
      const open = indexedDB.open('walkable', 1); open.onupgradeneeded = () => open.result.createObjectStore('handoff');
      open.onerror = () => rej(open.error);
      open.onsuccess = () => { const db = open.result; const tx = db.transaction('handoff', 'readwrite'); tx.objectStore('handoff').put(file, 'file'); tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); };
    });
  }
})();
