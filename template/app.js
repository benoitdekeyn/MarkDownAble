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

  // --- Barre des blocs de code : copier, agrandir, télécharger ---
  const EXTENSIONS = {
    bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh', powershell: 'ps1', ps1: 'ps1', pwsh: 'ps1', bat: 'bat', cmd: 'bat', dos: 'bat',
    javascript: 'js', js: 'js', jsx: 'jsx', mjs: 'mjs', cjs: 'cjs', typescript: 'ts', ts: 'ts', tsx: 'tsx',
    python: 'py', py: 'py', java: 'java', kotlin: 'kt', kt: 'kt', scala: 'scala', groovy: 'groovy',
    c: 'c', h: 'h', cpp: 'cpp', 'c++': 'cpp', cc: 'cpp', hpp: 'hpp', csharp: 'cs', cs: 'cs', 'c#': 'cs', objectivec: 'm',
    go: 'go', golang: 'go', rust: 'rs', rs: 'rs', swift: 'swift', dart: 'dart', php: 'php', ruby: 'rb', rb: 'rb',
    perl: 'pl', lua: 'lua', r: 'r', julia: 'jl', haskell: 'hs', elixir: 'ex', erlang: 'erl', clojure: 'clj',
    sql: 'sql', pgsql: 'sql', mysql: 'sql', plsql: 'sql', graphql: 'graphql',
    html: 'html', xml: 'xml', svg: 'svg', css: 'css', scss: 'scss', sass: 'sass', less: 'less',
    json: 'json', jsonc: 'jsonc', json5: 'json5', yaml: 'yml', yml: 'yml', toml: 'toml', ini: 'ini', properties: 'properties',
    markdown: 'md', md: 'md', latex: 'tex', tex: 'tex', diff: 'diff', patch: 'patch',
    dockerfile: 'Dockerfile', docker: 'Dockerfile', makefile: 'Makefile', make: 'Makefile', cmake: 'cmake',
    vue: 'vue', svelte: 'svelte', vb: 'vb', vbnet: 'vb', vba: 'bas', matlab: 'm', fortran: 'f90', cobol: 'cbl',
    plaintext: 'txt', text: 'txt', txt: 'txt',
  };
  const fileFor = (lang) => {
    const ext = EXTENSIONS[(lang || '').toLowerCase()] || 'txt';
    return /^[A-Z]/.test(ext) ? ext : `code.${ext}`;
  };
  // Icônes SVG intégrées (aucune dépendance externe).
  const icon = (d) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICONS = {
    copy: icon('<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>'),
    check: icon('<path d="M3 8.5l3.2 3.2L13 4.8"/>'),
    fail: icon('<path d="M4 4l8 8M12 4l-8 8"/>'),
    expand: icon('<path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9"/>'),
    collapse: icon('<path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5l4-4M6.5 9.5l-4 4"/>'),
    download: icon('<path d="M8 2.5v7.5M4.8 7.2L8 10.4l3.2-3.2M3 13.5h10"/>'),
  };
  const setIcon = (btn, name, label) => {
    btn.innerHTML = ICONS[name];
    if (label) { btn.title = label; btn.setAttribute('aria-label', label); }
  };
  $$('.copy-btn').forEach((b) => setIcon(b, 'copy'));
  $$('.expand-btn').forEach((b) => setIcon(b, 'expand'));
  $$('.download-btn').forEach((b) => setIcon(b, 'download'));
  const flash = (btn, ok) => {
    setIcon(btn, ok ? 'check' : 'fail');
    btn.classList.toggle('ok', ok);
    btn.classList.toggle('ko', !ok);
    setTimeout(() => { setIcon(btn, 'copy'); btn.classList.remove('ok', 'ko'); }, ok ? 1500 : 2000);
  };
  const copyText = async (text) => {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    area.remove();
    return ok;
  };
  const closeExpanded = () => {
    const open = $('.code-block.expanded');
    if (!open) return;
    open.classList.remove('expanded');
    document.body.classList.remove('code-open');
    const btn = $('.expand-btn', open);
    if (btn) setIcon(btn, 'expand', 'Agrandir le code');
  };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeExpanded(); });
  $$('.code-block').forEach((block) => {
    const frame = $('.code-frame', block);
    const code = () => $('code', block).innerText;
    const copy = $('.copy-btn', block);
    const expand = $('.expand-btn', block);
    const download = $('.download-btn', block);
    if (copy) copy.addEventListener('click', async () => flash(copy, await copyText(code())));
    if (expand) expand.addEventListener('click', () => {
      const wasOpen = block.classList.contains('expanded');
      closeExpanded();
      if (wasOpen) return;
      block.classList.add('expanded');
      document.body.classList.add('code-open');
      setIcon(expand, 'collapse', 'Réduire le code');
    });
    block.addEventListener('click', (e) => { if (e.target === block) closeExpanded(); });
    if (download) download.addEventListener('click', () => {
      const name = (frame && frame.dataset.filename) || fileFor(frame && frame.dataset.lang);
      const url = URL.createObjectURL(new Blob([code()], { type: 'text/plain;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
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
