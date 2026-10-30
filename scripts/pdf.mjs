// Export PDF : Chrome/Edge (via playwright-core) imprime la page, pdf-lib ajoute les en-têtes / pieds de page.
//  - le plan (signets) du PDF vient de l'impression de Chromium (titres h1-h6) ;
//  - les en-têtes / pieds sont dessinés après coup sur chaque page, ce qui permet d'y mettre le titre
//    de la section courante (Chromium ne sait pas le faire seul).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FORMATS = { a3: [11.69, 16.54, 'A3'], a4: [8.27, 11.69, 'A4'], a5: [5.83, 8.27, 'A5'], letter: [8.5, 11, 'Letter'], legal: [8.5, 14, 'Legal'], tabloid: [11, 17, 'Tabloid'] };
const UNITS = { mm: 96 / 25.4, cm: 96 / 2.54, in: 96, px: 1, pt: 96 / 72 };
const ZONES = ['left', 'center', 'right'];
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const PALETTE = {
  light: { bg: '#ffffff', fg: '#1f2328', muted: '#59636e', border: '#d1d9e0' },
  dark: { bg: '#0d1117', fg: '#e6edf3', muted: '#9198a1', border: '#3d444d' },
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function toPx(len) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mm|cm|in|px|pt)\s*$/i.exec(String(len));
  return m ? Number(m[1]) * UNITS[m[2].toLowerCase()] : NaN;
}

// Vérifie (et normalise) la section "pdf" de la configuration ; lève une Error au message lisible.
export function validatePdfConfig(p) {
  const fail = (m) => { throw new Error(`pdf.${m}`); };
  if (!p || typeof p !== 'object' || Array.isArray(p)) fail('doit être un objet');
  if (!['light', 'dark'].includes(p.theme)) fail(`theme doit valoir light ou dark (reçu "${p.theme}")`);
  const f = FORMATS[String(p.format).toLowerCase()];
  if (!f) fail(`format "${p.format}" inconnu (${Object.values(FORMATS).map((x) => x[2]).join(', ')})`);
  p.format = f[2];
  if (!(typeof p.zoom === 'number' && p.zoom >= 10 && p.zoom <= 200)) fail('zoom doit être un nombre entre 10 et 200 (en %)');
  if (typeof p.landscape !== 'boolean') fail('landscape doit valoir true ou false');
  if (p.browser != null && typeof p.browser !== 'string') fail('browser doit être null ou un chemin de fichier');
  if (!p.margins || typeof p.margins !== 'object' || Array.isArray(p.margins)) fail('margins doit être un objet avec top, right, bottom et left');
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const px = toPx(p.margins[side]);
    if (!(Number.isFinite(px) && px >= 0)) fail(`margins.${side} : longueur invalide "${p.margins[side]}" (ex. "20mm", "2cm", "0.8in")`);
  }
  if (!Array.isArray(p.pageBreakBefore) || !p.pageBreakBefore.every((n) => Number.isInteger(n) && n >= 1 && n <= 6)) {
    fail('pageBreakBefore doit être un tableau de niveaux de 1 à 6 (ex. [1, 2])');
  }
  if (typeof p.hideToc !== 'boolean') fail('hideToc doit valoir true ou false');
  for (const k of ['keepSectionsTogether', 'keepBlocksTogether']) if (typeof p[k] !== 'boolean') fail(`${k} doit valoir true ou false`);
  for (const part of ['header', 'footer']) {
    const z = p[part];
    if (z == null) continue;
    if (typeof z !== 'object' || Array.isArray(z)) fail(`${part} doit être null ou un objet { left, center, right, style }`);
    for (const k of Object.keys(z)) if (![...ZONES, 'style'].includes(k)) fail(`${part} : clé inconnue "${k}"${k === 'skipFirstPage' ? ' (remplacée par \\nohf ou <!-- nohf --> dans le Markdown)' : ''}`);
    for (const k of [...ZONES, 'style']) if (z[k] != null && typeof z[k] !== 'string') fail(`${part}.${k} doit être une chaîne`);
  }
}

// Dimensions utiles à la mise en page (px CSS, avant zoom).
export function pdfGeometry(p) {
  const [w, h] = FORMATS[String(p.format).toLowerCase()];
  const [pw, ph] = p.landscape ? [h, w] : [w, h];
  const innerH = ph * 96 - toPx(p.margins.top) - toPx(p.margins.bottom);
  return { figHeight: Math.floor((innerH / (p.zoom / 100)) * 0.96) };
}

async function launch(chromium, browserPath) {
  if (browserPath) return chromium.launch({ executablePath: path.resolve(browserPath), headless: true });
  const errors = [];
  for (const channel of ['chrome', 'msedge']) {
    try { return await chromium.launch({ channel, headless: true }); } catch (e) { errors.push(`${channel} : ${e.message.split('\n')[0]}`); }
  }
  throw new Error(`Aucun Chrome / Edge trouvé (${errors.join(' ; ')}). Installez-en un ou renseignez pdf.browser dans <nom>.jsonc.`);
}

// Outils de lecture des destinations PDF (explicites ou nommées).
function destTools(doc, lib) {
  const { PDFName, PDFDict, PDFArray, PDFString, PDFHexString, PDFRef } = lib;
  const N = (s) => PDFName.of(s);
  const pageOf = new Map(doc.getPages().map((pg, i) => [pg.ref.tag, i]));
  const text = (o) => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : o instanceof PDFName ? o.decodeText() : null);
  const fromDest = (d) => {
    if (d instanceof PDFDict) d = d.lookup(N('D'));
    if (d instanceof PDFArray) { const r = d.get(0); return r instanceof PDFRef ? pageOf.get(r.tag) : undefined; }
    return undefined;
  };
  // Destinations nommées : dictionnaire /Dests (PDF 1.1) ou arbre de noms /Names -> /Dests
  const findNamed = (name) => {
    const dests = doc.catalog.lookupMaybe(N('Dests'), PDFDict);
    if (dests) { const v = dests.lookup(N(name)); if (v) return v; }
    const names = doc.catalog.lookupMaybe(N('Names'), PDFDict)?.lookupMaybe(N('Dests'), PDFDict);
    const walkTree = (node) => {
      const arr = node.lookupMaybe(N('Names'), PDFArray);
      if (arr) for (let i = 0; i + 1 < arr.size(); i += 2) if (text(arr.lookup(i)) === name) return arr.lookup(i + 1);
      const kids = node.lookupMaybe(N('Kids'), PDFArray);
      if (kids) for (let i = 0; i < kids.size(); i++) { const r = walkTree(kids.lookup(i, PDFDict)); if (r) return r; }
      return undefined;
    };
    return names ? walkTree(names) : undefined;
  };
  return { N, text, fromDest, findNamed };
}

// Page (index 0) de chaque destination nommée, undefined si absente.
function namedPages(doc, lib, ids) {
  if (!ids.length) return [];
  const { fromDest, findNamed } = destTools(doc, lib);
  return ids.map((id) => fromDest(findNamed(id)));
}

// ---------- plan du PDF (signets) ----------
function readOutline(doc, lib) {
  const { PDFDict } = lib;
  const { N, text, fromDest, findNamed } = destTools(doc, lib);
  const root = doc.catalog.lookupMaybe(N('Outlines'), PDFDict);
  if (!root) return [];

  const out = [];
  const walk = (item, depth) => {
    for (let n = item; n; n = n.lookupMaybe(N('Next'), PDFDict)) {
      let d = n.lookup(N('Dest'));
      if (!d) { const a = n.lookupMaybe(N('A'), PDFDict); d = a && a.lookup(N('D')); }
      const nm = text(d);
      if (nm != null) d = findNamed(nm);
      out.push({ title: text(n.lookup(N('Title'))) ?? '', depth, page: fromDest(d) });
      const kid = n.lookupMaybe(N('First'), PDFDict);
      if (kid) walk(kid, depth + 1);
    }
  };
  const first = root.lookupMaybe(N('First'), PDFDict);
  if (first) walk(first, 1);
  return out;
}

const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

// Associe chaque signet à un titre du document (donc à son vrai niveau h1..h6).
function alignSections(outline, domHeadings, warn) {
  if (outline.length === domHeadings.length) return outline.map((o, i) => ({ level: domHeadings[i].level, title: domHeadings[i].text, page: o.page }));
  warn(`le plan du PDF compte ${outline.length} entrées pour ${domHeadings.length} titres : association par le texte`);
  const out = [];
  let k = 0;
  for (const o of outline) {
    let j = k;
    while (j < domHeadings.length && norm(domHeadings[j].text) !== norm(o.title)) j++;
    if (j < domHeadings.length) { out.push({ level: domHeadings[j].level, title: domHeadings[j].text, page: o.page }); k = j + 1; }
    else out.push({ level: o.depth, title: o.title, page: o.page });
  }
  return out;
}

// Titres applicables à chaque page : pour un niveau N, le premier titre de ce niveau qui commence sur la page,
// sinon celui en vigueur au début de la page (vide si un titre de niveau supérieur commence sur la page).
function sectionsPerPage(sections, pageCount) {
  const list = sections.filter((s) => s.page != null).sort((a, b) => a.page - b.page);
  const pages = [];
  let cur = {};
  let k = 0;
  for (let p = 0; p < pageCount; p++) {
    const start = { ...cur };
    const first = {};
    let minStarted = 7;
    while (k < list.length && list[k].page <= p) {
      const s = list[k++];
      if (!(s.level in first)) first[s.level] = s.title;
      cur[s.level] = s.title;
      for (let l = s.level + 1; l <= 6; l++) delete cur[l];
      minStarted = Math.min(minStarted, s.level);
    }
    const vals = {};
    for (let n = 1; n <= 6; n++) vals[`h${n}`] = first[n] ?? (minStarted < n ? '' : start[n] ?? '');
    pages.push(vals);
  }
  return pages;
}

// ---------- en-têtes / pieds de page ----------
function inlineImages(html, baseDir, warn) {
  return html.replace(/(<img\b[^>]*?\bsrc=")([^"]+)(")/gi, (all, a, ref, z) => {
    if (/^(data:|https?:|file:)/i.test(ref)) return all;
    const file = path.resolve(baseDir, ref);
    if (!fs.existsSync(file)) { warn(`image introuvable dans l'en-tête / le pied de page : ${ref}`); return all; }
    const mime = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    return `${a}data:${mime};base64,${fs.readFileSync(file).toString('base64')}${z}`;
  });
}

function overlayHtml({ cfg, baseDir, size, pages, sections, title, noHF, warn }) {
  const p = cfg.pdf;
  const pal = { ...PALETTE[p.theme], ...(cfg.style.colors[p.theme] || {}) };
  const date = new Date().toLocaleDateString(cfg.global.language || 'fr');
  const zones = {};
  for (const part of ['header', 'footer']) {
    const z = p[part];
    if (!z) continue;
    zones[part] = { z, tpl: Object.fromEntries(ZONES.map((k) => [k, inlineImages(z[k] || '', baseDir, warn)])) };
  }
  const fill = (tpl, vals) => tpl.replace(/\{(page|pages|title|date|h[1-6])\}/g, (_, k) => esc(vals[k] ?? ''));

  const sheets = pages.map((vals, i) => {
    const v = { ...vals, page: i + 1, pages: pages.length, title, date };
    const bar = (part) => {
      const zone = zones[part];
      if (!zone || noHF.has(i)) return '';
      const cells = ZONES.map((k) => `<div class="${k}">${fill(zone.tpl[k], v)}</div>`).join('');
      return `<div class="bar ${part}" style="${esc(zone.z.style || '')}">${cells}</div>`;
    };
    return `<section class="pg">${bar('header')}${bar('footer')}</section>`;
  });

  const heightPx = size.h * 96 / 72;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@page{margin:0}
html,body{margin:0;padding:0;background:transparent}
body{font-family:${cfg.style.fontFamily};color:${pal.muted};-webkit-print-color-adjust:exact;print-color-adjust:exact}
.pg{position:relative;overflow:hidden;width:${size.w * 96 / 72}px;height:calc(${heightPx}px - 2px);break-after:page}
.pg:last-child{break-after:auto}
.bar{position:absolute;left:0;right:0;box-sizing:border-box;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:12px;
  padding:0 ${p.margins.right} 0 ${p.margins.left};font-size:9pt;line-height:1.3;color:${pal.muted}}
.bar.header{top:0;height:${p.margins.top}}
.bar.footer{bottom:0;height:${p.margins.bottom}}
.bar>div{min-width:0}.bar .left{text-align:left}.bar .center{text-align:center}.bar .right{text-align:right}
.bar img{vertical-align:middle;max-height:100%}
</style></head><body>${sheets.join('')}</body></html>`;
}

// ---------- export ----------
export async function exportPdf({ cfg, html, ConfigError, warn }) {
  const p = cfg.pdf;
  const [{ chromium }, lib] = await Promise.all([import('playwright-core'), import('pdf-lib')]);
  const baseDir = path.dirname(cfg.sourcePath);
  const tmpFile = path.join(baseDir, `.markdown-pdf-${process.pid}.html`);
  let browser;
  try {
    try { browser = await launch(chromium, p.browser); } catch (e) { throw new ConfigError(e.message); }
    const page = await browser.newPage();
    page.on('pageerror', (e) => warn(`erreur dans la page : ${e.message}`));
    fs.writeFileSync(tmpFile, html);
    await page.goto(pathToFileURL(tmpFile).href, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__PDF_DONE__, null, { timeout: 300000 });
    const done = await page.evaluate(() => window.__PDF_DONE__);
    done.errors.forEach((m) => warn(m));
    done.brokenImages.forEach((s) => warn(`image non chargée : ${s}`));

    const first = await page.pdf({
      format: p.format, landscape: p.landscape, scale: p.zoom / 100, printBackground: true,
      margin: p.margins, outline: true, tagged: true, displayHeaderFooter: false,
    });
    const doc = await lib.PDFDocument.load(first);
    const count = doc.getPageCount();
    const outline = readOutline(doc, lib);
    if (p.header || p.footer) {
      const { width: w, height: h } = doc.getPage(0).getSize();
      const sections = alignSections(outline, done.headings, warn);
      const title = cfg.global.title || path.parse(cfg.sourcePath).name;
      const noHF = new Set(done.noHF.first ? [0] : []);
      const named = namedPages(doc, lib, done.noHF.ids);
      done.noHF.ids.forEach((id, k) => {
        if (named[k] == null) warn(`\\nohf n°${k + 1} : page introuvable dans le PDF, repère ignoré`);
        else noHF.add(named[k]);
      });
      const html2 = overlayHtml({ cfg, baseDir: path.dirname(cfg.configPath), size: { w, h }, pages: sectionsPerPage(sections, count), sections, title, noHF, warn });
      const ov = await browser.newPage();
      await ov.setContent(html2, { waitUntil: 'load' });
      const bytes = await ov.pdf({
        width: `${w / 72}in`, height: `${h / 72}in`, margin: { top: '0', right: '0', bottom: '0', left: '0' },
        printBackground: true, omitBackground: true, displayHeaderFooter: false,
      });
      const overDoc = await lib.PDFDocument.load(bytes);
      if (overDoc.getPageCount() < count) throw new Error(`en-têtes : ${overDoc.getPageCount()} pages générées pour ${count}`);
      const embedded = await doc.embedPdf(overDoc, Array.from({ length: count }, (_, i) => i));
      doc.getPages().forEach((pg, i) => {
        const s = pg.getSize();
        pg.drawPage(embedded[i], { x: 0, y: 0, width: s.width, height: s.height });
      });
    }
    doc.setTitle(cfg.global.title || path.parse(cfg.sourcePath).name);
    const out = await doc.save();
    fs.mkdirSync(path.dirname(cfg.pdfFile), { recursive: true });
    fs.writeFileSync(cfg.pdfFile, out);
    return { pages: count, bookmarks: outline.length, bytes: out.length };
  } finally {
    if (browser) await browser.close();
    if (!process.env.MARKDOWN_KEEP_TMP) fs.rmSync(tmpFile, { force: true });
  }
}
