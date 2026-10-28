(() => {
  const CFG = window.__DOCUMENT__;
  const root = document.documentElement;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const store = {
    get: (k) => { try { return localStorage.getItem(`${CFG.key}:${k}`); } catch (_) { return null; } },
    set: (k, v) => { try { localStorage.setItem(`${CFG.key}:${k}`, v); } catch (_) {} },
  };

  // --- Navigation interne (comme GitHub : fragments encodés ou non, insensibles à la casse) ---
  function findTarget(hash) {
    const id = hash.replace(/^#/, '');
    if (!id) return null;
    const candidates = [id];
    try { candidates.push(decodeURIComponent(id)); } catch (_) {}
    for (const c of candidates) {
      const el = document.getElementById(c) || document.getElementById(c.toLowerCase());
      if (el) return el;
    }
    return null;
  }
  function goTo(hash, push) {
    const el = findTarget(hash);
    if (!el) return false;
    el.scrollIntoView();
    if (push) history.pushState(null, '', hash);
    document.body.classList.remove('sidebar-open');
    return true;
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a || e.defaultPrevented || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (goTo(a.getAttribute('href'), true)) e.preventDefault();
  });
  window.addEventListener('hashchange', () => goTo(location.hash, false));

  // --- Boutons "Copier" ---
  $$('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const code = $('code', btn.parentElement).innerText;
      try {
        await navigator.clipboard.writeText(code);
        btn.textContent = 'Copié ✓';
      } catch (_) {
        btn.textContent = 'Échec';
      }
      setTimeout(() => (btn.textContent = 'Copier'), 1500);
    });
  });

  // --- Sommaire : arbre repliable + suivi de la section visible ---
  const toc = $('#toc');
  const links = $$('a[data-id]', toc);
  const byId = new Map(links.map((a) => [a.dataset.id, a]));
  const headings = links.map((a) => document.getElementById(a.dataset.id)).filter(Boolean);
  const tocNodes = $$('.toc-node', toc);
  const kidsOf = (n) => $$(':scope > .toc-children > .toc-node', n);
  const manual = new Set(); // dépliés par l'utilisateur
  const closed = new Set(); // repliés par l'utilisateur alors qu'ils contiennent la section visible
  let auto = new Set();     // ancêtres de la section visible
  let current = null;

  function applyOpen() {
    tocNodes.forEach((n) => n.classList.toggle('open', (manual.has(n) || auto.has(n)) && !closed.has(n)));
  }
  // Déplier n'ouvre que ce titre : ses sous-titres restent dans leur état.
  function expand(n) { manual.add(n); closed.delete(n); applyOpen(); }
  // Replier remet aussi à zéro tous les sous-titres : le prochain dépliage repart d'un arbre condensé.
  function collapse(n) {
    for (const d of [n, ...$$('.toc-node', n)]) { manual.delete(d); closed.delete(d); }
    closed.add(n);
    applyOpen();
  }
  toc.addEventListener('click', (e) => {
    const caret = e.target.closest('button.toc-caret');
    const a = e.target.closest('a[data-id]');
    const node = (caret || a) && (caret || a).closest('.toc-node');
    if (!node) return;
    if (caret && node.classList.contains('open')) collapse(node);
    else expand(node);
  });

  // Le sommaire défile seul (jamais la page) et on ne le déplace pas pendant que l'utilisateur le manipule.
  let lastTocUse = 0;
  ['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach((ev) =>
    toc.addEventListener(ev, () => { lastTocUse = Date.now(); }, { passive: true }));
  function revealInToc(a) {
    if (Date.now() - lastTocUse < 2500) return;
    const box = toc.getBoundingClientRect();
    const r = a.getBoundingClientRect();
    if (r.top >= box.top + 8 && r.bottom <= box.bottom - 8) return;
    toc.scrollTop += r.top - box.top - box.height / 2 + r.height / 2;
  }
  function setActive(id) {
    if (id === current) return;
    current = id;
    links.forEach((a) => a.classList.remove('active'));
    closed.clear();
    auto = new Set();
    const a = byId.get(id);
    if (a) {
      a.classList.add('active');
      for (let n = a.closest('.toc-node').parentElement.closest('.toc-node'); n; n = n.parentElement.closest('.toc-node')) auto.add(n);
    }
    applyOpen();
    if (a) revealInToc(a);
  }
  function onScroll() {
    let active = headings[0];
    for (const h of headings) {
      if (h.getBoundingClientRect().top <= 80) active = h;
      else break;
    }
    if (active) setActive(active.id);
  }
  let ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { onScroll(); ticking = false; });
  }, { passive: true });

  // --- Filtre du sommaire ---
  function filterNode(n, q) {
    const a = $(':scope > .toc-row a', n);
    let any = !q || a.textContent.toLowerCase().includes(q);
    for (const k of kidsOf(n)) any = filterNode(k, q) || any;
    n.classList.toggle('hidden', !any);
    return any;
  }
  $('#toc-filter').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    toc.classList.toggle('filtering', !!q);
    $$(':scope > .toc-node', toc).forEach((n) => filterNode(n, q));
  });

  $('#sidebar-toggle').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));

  // --- Redimensionnement du sommaire par glisser-déposer de sa bordure ---
  const resizer = $('#resizer');
  const clampW = (w) => Math.max(CFG.sidebarMin, Math.min(CFG.sidebarMax, Math.min(w, window.innerWidth * 0.8)));
  const setW = (w) => root.style.setProperty('--sidebar-w', `${Math.round(clampW(w))}px`);
  resizer.addEventListener('pointerdown', (e) => {
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    e.preventDefault();
  });
  resizer.addEventListener('pointermove', (e) => {
    if (resizer.hasPointerCapture(e.pointerId)) setW(e.clientX);
  });
  const endDrag = (e) => {
    if (!resizer.hasPointerCapture(e.pointerId)) return;
    resizer.releasePointerCapture(e.pointerId);
    document.body.classList.remove('resizing');
    store.set('sidebar', parseInt(getComputedStyle(root).getPropertyValue('--sidebar-w'), 10));
  };
  resizer.addEventListener('pointerup', endDrag);
  resizer.addEventListener('pointercancel', endDrag);
  resizer.addEventListener('dblclick', () => { setW(CFG.sidebarWidth); store.set('sidebar', CFG.sidebarWidth); });
  const saved = parseInt(store.get('sidebar'), 10);
  if (saved) setW(saved);

  // --- Thème : auto -> clair -> sombre ---
  const themeBtn = $('#theme-toggle');
  const labels = { auto: '◐ Auto', light: '☀ Clair', dark: '☾ Sombre' };
  const dm = matchMedia('(prefers-color-scheme: dark)');
  let mode = root.dataset.mode;
  function applyCodeTheme() {
    const codeMode = CFG.codeThemeMode;
    const dark = codeMode === 'dark' || (codeMode === 'follow' ? root.dataset.theme === 'dark' : codeMode === 'auto' && dm.matches);
    root.dataset.codeTheme = dark ? 'dark' : 'light';
  }
  function applyTheme() {
    const dark = mode === 'dark' || (mode === 'auto' && dm.matches);
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.mode = mode;
    applyCodeTheme();
    themeBtn.textContent = labels[mode];
    renderMermaid();
  }
  themeBtn.addEventListener('click', () => {
    mode = { auto: 'light', light: 'dark', dark: 'auto' }[mode];
    store.set('theme', mode);
    applyTheme();
  });
  dm.addEventListener('change', () => {
    if (mode === 'auto') applyTheme();
    else if (CFG.codeThemeMode === 'auto') applyCodeTheme();
  });

  // --- Mermaid (re-rendu à chaque changement de thème, une seule exécution à la fois) ---
  const ACTIONS = [
    ['up', '▲', 'Haut', (p) => p.panBy({ x: 0, y: 60 })], ['in', '+', 'Zoom avant', (p) => p.zoomIn()],
    ['left', '◀', 'Gauche', (p) => p.panBy({ x: 60, y: 0 })], ['reset', '⟲', 'Réinitialiser', (p) => { p.resize(); p.fit(); p.center(); }],
    ['right', '▶', 'Droite', (p) => p.panBy({ x: -60, y: 0 })], ['down', '▼', 'Bas', (p) => p.panBy({ x: 0, y: -60 })],
    ['out', '−', 'Zoom arrière', (p) => p.zoomOut()],
  ];
  const mkBtn = (cls, text, title) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = cls; b.textContent = text; b.title = title; b.setAttribute('aria-label', title);
    return b;
  };
  function addControls(host, getPz) {
    const c = document.createElement('div');
    c.className = 'mm-controls mm-ui';
    for (const [act, text, title, fn] of ACTIONS) {
      const b = mkBtn('mm-btn', text, title);
      b.dataset.act = act;
      b.addEventListener('click', () => fn(getPz()));
      c.appendChild(b);
    }
    host.appendChild(c);
  }
  function newPz(svg, wheel) {
    return svgPanZoom(svg, { controlIconsEnabled: false, mouseWheelZoomEnabled: wheel, dblClickZoomEnabled: false, fit: true, center: true, minZoom: 0.2, maxZoom: 30, zoomScaleSensitivity: 0.3 });
  }
  function decorate(box) {
    const svg = $('svg', box);
    if (!svg || !window.svgPanZoom) return;
    box._raw = svg.outerHTML;
    svg.style.height = `${svg.getBoundingClientRect().height}px`; // hauteur figée : svg-pan-zoom en a besoin
    box._pz = newPz(svg, false);
    const exp = mkBtn('mm-btn mm-expand mm-ui', '⤢', 'Plein écran');
    exp.addEventListener('click', () => openFull(box));
    box.appendChild(exp);
    addControls(box, () => box._pz);
  }
  function openFull(box) {
    const ov = document.createElement('div');
    ov.className = 'mm-overlay';
    const stage = document.createElement('div');
    stage.className = 'mm-stage';
    stage.innerHTML = box._raw;
    const svg = stage.firstElementChild;
    svg.removeAttribute('width'); svg.removeAttribute('height'); svg.removeAttribute('style');
    const close = mkBtn('mm-btn mm-expand', '✕', 'Fermer (Échap)');
    ov.append(stage, close);
    document.body.append(ov);
    document.body.classList.add('mm-open');
    let pz = newPz(svg, true);
    addControls(ov, () => pz);
    const onResize = () => { pz.resize(); pz.fit(); pz.center(); };
    const end = () => {
      pz.destroy();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
      document.body.classList.remove('mm-open');
    };
    const onKey = (e) => { if (e.key === 'Escape') end(); };
    close.addEventListener('click', end);
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKey, true);
  }

  $$('pre.mermaid').forEach((n) => { n.dataset.src = n.textContent; });
  let mermaidQueue = Promise.resolve();
  function renderMermaid() {
    if (!window.mermaid) return mermaidQueue;
    mermaidQueue = mermaidQueue.then(async () => {
      const theme = CFG.mermaidTheme === 'auto' ? (root.dataset.theme === 'dark' ? 'dark' : 'default') : CFG.mermaidTheme;
      if (window.__elk && mermaid.registerLayoutLoaders) mermaid.registerLayoutLoaders(window.__elk.default);
      const dark = root.dataset.theme === 'dark';
      const css = CFG.mermaidCss;
      mermaid.initialize({ startOnLoad: false, theme, securityLevel: 'strict', themeCSS: `${css.common}\n${dark ? css.dark : css.light}` });
      const nodes = $$('pre.mermaid');
      nodes.forEach((n) => {
        const box = n.parentElement;
        if (box._pz) { try { box._pz.destroy(); } catch (_) {} box._pz = null; }
        $$('.mm-ui', box).forEach((x) => x.remove());
        n.textContent = n.dataset.src;
        n.removeAttribute('data-processed');
      });
      try { await mermaid.run({ nodes }); } catch (e) { console.error('Mermaid :', e); }
      nodes.forEach((n) => decorate(n.parentElement));
    });
    return mermaidQueue;
  }

  themeBtn.textContent = labels[mode];
  window.addEventListener('load', async () => {
    await renderMermaid();
    // Images et diagrammes changent la hauteur de page : on se replace sur l'ancre demandée.
    if (location.hash) goTo(location.hash, false);
    onScroll();
  });
  onScroll();
})();
