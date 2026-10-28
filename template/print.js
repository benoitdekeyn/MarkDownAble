// Script de la page d'impression PDF : sauts de page, rendu des diagrammes Mermaid, puis signal « prêt ».
(async () => {
  const CFG = window.__DOCUMENT__;
  const P = window.__PDF__;
  const root = document.documentElement;
  const article = document.querySelector('.markdown-body');
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const isHeading = (el) => !!el && /^H[1-6]$/.test(el.tagName);
  const errors = [];
  const codeMode = CFG.codeThemeMode;
  root.dataset.codeTheme = (codeMode === 'dark' || (codeMode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches)
    || (codeMode === 'follow' && root.dataset.theme === 'dark')) ? 'dark' : 'light';

  // Sections dépliables (<details>) : ouvertes à l'impression, sinon leur contenu serait absent du PDF.
  $$('details', article).forEach((d) => { d.open = true; });

  // Repère les éléments situés entre <!-- TOC --> et <!-- /TOC --> (pour le style d'impression de la TOC).
  {
    const kids = [...article.childNodes];
    const isC = (n, v) => n.nodeType === 8 && n.data.trim().toLowerCase() === v;
    const a = kids.findIndex((n) => isC(n, 'toc'));
    const b = kids.findIndex((n) => isC(n, '/toc'));
    if (a >= 0 && b > a) kids.slice(a, b).forEach((n) => n.nodeType === 1 && n.classList.add('toc-block'));
  }

  // Table des matières Markdown (entre <!-- TOC --> et <!-- /TOC -->), avec son titre s'il la précède directement.
  if (P.hideToc) {
    const nodes = [...article.childNodes];
    const isC = (n, v) => n.nodeType === 8 && n.data.trim().toLowerCase() === v;
    const a = nodes.findIndex((n) => isC(n, 'toc'));
    const b = nodes.findIndex((n) => isC(n, '/toc'));
    if (a < 0 || b < a) errors.push('pdf.hideToc : repères <!-- TOC --> / <!-- /TOC --> introuvables dans le Markdown');
    else {
      const prev = nodes[a].previousElementSibling;
      nodes.slice(a, b + 1).forEach((n) => n.remove());
      if (isHeading(prev)) prev.remove();
    }
  }

  // \samepage juste avant un titre : annule le saut de page imposé par pdf.pageBreakBefore pour ce titre.
  $$('.samepage', article).forEach((m) => {
    const next = m.nextElementSibling;
    if (isHeading(next)) next.dataset.samepage = '1';
    else errors.push('\\samepage ignoré : il doit être placé juste avant un titre');
    m.remove();
  });

  // Pages sans en-tête ni pied de page (\nohf) : uniquement en tout début de document ou juste après un saut de page.
  const noHF = { first: false, ids: [] };
  $$('.nohf', article).forEach((m) => {
    const prev = m.previousElementSibling;
    const next = m.nextElementSibling;
    if (prev && !prev.classList.contains('pagebreak')) {
      errors.push('\\nohf ignoré : il doit être en première ligne du document ou juste après un saut de page (\\newpage)');
    } else if (!prev) {
      noHF.first = true;
    } else if (next) {
      // Repère de page : une destination nommée Chromium permet de retrouver le n° de page dans le PDF.
      const id = `nohf-${noHF.ids.length}`;
      const s = document.createElement('span');
      s.id = id;
      s.dataset.nohf = '1';
      s.style.cssText = 'display:block;height:0';
      article.insertBefore(s, next);
      noHF.ids.push(id);
    }
    m.remove();
  });
  if (noHF.ids.length) {
    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    box.innerHTML = noHF.ids.map((id) => `<a href="#${id}">.</a>`).join('');
    article.appendChild(box);
  }

  // Sauts de page demandés dans le Markdown : le bloc qui suit commence une nouvelle page.
  // Si le marqueur termine son conteneur (élément de liste, citation…), le saut s'applique à l'élément suivant du parent.
  $$('.pagebreak', article).forEach((m) => {
    let el = m;
    while (el && el !== article && !el.nextElementSibling) el = el.parentElement;
    const target = el && el !== article ? el.nextElementSibling : null;
    // Un saut ne s'applique qu'à un bloc : devant un élément en ligne (<br>, <a>…), le marqueur devient lui-même un bloc de hauteur nulle.
    const inline = target && getComputedStyle(target).display.startsWith('inline');
    if (!target) m.remove();
    else if (el === m && inline) { m.className = 'pb'; m.style.cssText = 'display:block;height:0;margin:0;padding:0'; }
    else { target.classList.add('pb'); m.remove(); }
  });
  // Saut avant les niveaux de titres choisis (sauf en tout début de document, juste après un autre titre ou un saut déjà posé).
  $$('h1,h2,h3,h4,h5,h6', article).forEach((h) => {
    const prev = h.previousElementSibling;
    if (P.breakLevels.includes(Number(h.tagName[1])) && !h.dataset.samepage && prev && !isHeading(prev) && !prev.classList.contains('pb')) h.classList.add('pb');
  });

  // Garde-fou : du texte directement sous <article> (hors bloc) serait écarté par le regroupement en sections et
  // apparaîtrait en tête de page. On le signale plutôt que de produire un PDF silencieusement faux.
  const stray = [...article.childNodes].filter((n) => n.nodeType === 3 && n.data.trim());
  if (stray.length) errors.push(`${stray.length} fragment(s) de texte hors paragraphe (HTML invalide dans le Markdown ?), ex. « ${stray[0].data.trim().slice(0, 60)} »`);

  // Sections hiérarchiques : un titre regroupe son contenu et ses sous-sections. Chromium garde le groupe le plus large
  // qui tient sur une page, et ne le coupe que si aucun regroupement ne tient.
  root.classList.toggle('keep-blocks', !!P.keepBlocks);
  if (P.keepSections) {
    const mk = (parent, before) => {
      const d = document.createElement('div');
      d.className = 'pdf-seg';
      parent.insertBefore(d, before);
      return d;
    };
    const stack = [];
    for (const el of [...article.children]) {
      if (isHeading(el)) {
        const lvl = Number(el.tagName[1]);
        while (stack.length && stack[stack.length - 1].lvl >= lvl) stack.pop();
        const parent = stack.length ? stack[stack.length - 1].div : article;
        const div = mk(parent, null);
        stack.push({ lvl, div });
        div.appendChild(el);
      } else {
        if (!stack.length) stack.push({ lvl: 0, div: mk(article, el) });
        stack[stack.length - 1].div.appendChild(el);
      }
    }
  }

  // Diagrammes Mermaid, un par un pour isoler les erreurs.
  const nodes = $$('pre.mermaid');
  if (nodes.length && window.mermaid) {
    const dark = root.dataset.theme === 'dark';
    const theme = CFG.mermaidTheme === 'auto' ? (dark ? 'dark' : 'default') : CFG.mermaidTheme;
    if (window.__elk && mermaid.registerLayoutLoaders) mermaid.registerLayoutLoaders(window.__elk.default);
    mermaid.initialize({ startOnLoad: false, theme, securityLevel: 'strict', themeCSS: `${CFG.mermaidCss.common}\n${dark ? CFG.mermaidCss.dark : CFG.mermaidCss.light}` });
    for (const [i, n] of nodes.entries()) {
      try {
        await mermaid.run({ nodes: [n] });
        if (!n.querySelector('svg')) errors.push(`diagramme Mermaid n°${i + 1} : aucun rendu`);
      } catch (e) {
        errors.push(`diagramme Mermaid n°${i + 1} : ${e && e.message ? e.message : e}`);
      }
    }
  }

  await document.fonts.ready;
  await Promise.all($$('img').map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));

  const headings = $$('h1,h2,h3,h4,h5,h6', article).map((h) => {
    const c = h.cloneNode(true);
    $$('.anchor', c).forEach((a) => a.remove());
    return { level: Number(h.tagName[1]), text: c.textContent.replace(/\s+/g, ' ').trim() };
  });
  window.__PDF_DONE__ = { errors, headings, noHF, brokenImages: $$('img').filter((i) => !i.naturalWidth).map((i) => i.getAttribute('src')) };
})();
