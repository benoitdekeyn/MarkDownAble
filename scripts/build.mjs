// Convertit les documents Markdown de doc/ en pages HTML (output_html/) ou en PDF (output_pdf/).
// Chaque doc/<nom>.md est traité si doc/<nom>.jsonc existe et est valide.
// Usage : node scripts/build.mjs [nom…]           -> output_html/<nom>/<htmlName>.html + médias utilisés
//         node scripts/build.mjs --pdf [nom…]     -> output_pdf/<nom>.pdf
//         node scripts/build.mjs --watch [nom…]   -> sert les pages sur http://localhost:4173 avec rechargement automatique
// Options : --open (ouvre le HTML dans le navigateur par défaut, ou le PDF dans son lecteur ; rien n'est ouvert par défaut)
//          --no-open (en mode --watch, n'ouvre pas le navigateur)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import MarkdownIt from 'markdown-it';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import hljs from 'highlight.js';
import GithubSlugger from 'github-slugger';
import { exportPdf, pdfGeometry, validatePdfConfig } from './pdf.mjs';
import { isObj, merge } from './jsonc.mjs';
import { DOC_DIR, TEMPLATE_DIR, HTML_OUTPUT_DIR, PDF_OUTPUT_DIR, STATE_DIR, PATHS_FILE, CONFIG_SUFFIX, ConfigError, discoverDocs, reloadPaths, rel, isToolFile } from './workspace.mjs';
import { log } from './log.mjs';

const require = createRequire(import.meta.url);
const WATCH = process.argv.includes('--watch');
const PDF = process.argv.includes('--pdf');
const NAMES = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const PORT = process.env.PORT === undefined ? 4173 : Number(process.env.PORT);
const FLAGS = new Set(['--watch', '--pdf', '--open', '--no-open']);
const UNKNOWN_FLAGS = process.argv.slice(2).filter((a) => a.startsWith('--') && !FLAGS.has(a));

const DEFAULTS = {
  global: {
    title: null,
    icon: null,
    language: 'fr',
    fontScale: 100,
    zoom: 100,
    fonts: {
      headings: null,
      body: "-apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
      code: "ui-monospace, 'Cascadia Code', Consolas, 'SFMono-Regular', monospace",
      math: null,
    },
  },
  html: {
    name: 'index',
    theme: 'auto',
    embedImages: false,
    tocOpenLevel: 2,
    sidebarWidth: 320,
    sidebarMinWidth: 200,
    sidebarMaxWidth: 700,
    contentWidthPercent: 90,
  },
  pdf: {
    name: null,
    theme: 'light',
    format: 'A4',
    landscape: false,
    zoom: 100,
    fontScale: 100,
    fonts: { headings: null, body: null, code: null, math: null },
    margins: { top: '20mm', right: '18mm', bottom: '20mm', left: '18mm' },
    pageBreakBefore: [],
    hideToc: false,
    keepSectionsTogether: true,
    keepBlocksTogether: true,
    browser: null,
    header: null,
    footer: { center: '{page} / {pages}' },
  },
  style: {
    codeFontSize: '85%',
    highlight: { light: 'default', dark: 'default' },
    codeTheme: { mode: 'follow' },
    codeLanguage: true,
    pageTheme: { light: 'default', dark: 'default' },
    pagePalettes: {},
    mermaidTheme: 'auto',
    mermaid: { layout: 'dagre', direction: null },
    // Unité : em (multiple de la taille de base ; 1 = taille du texte).
    headings: {
      1: { size: 2, indent: 0, color: null }, 2: { size: 1.5, indent: 0, color: null }, 3: { size: 1.25, indent: 0, color: null },
      4: { size: 1, indent: 0, color: null }, 5: { size: 0.875, indent: 0, color: null }, 6: { size: 0.85, indent: 0, color: null },
    },
    toc: {
      1: { size: 1.1, indent: 0, color: null }, 2: { size: 1, indent: 0, color: null }, 3: { size: 1, indent: 1.5, color: null },
      4: { size: 0.93, indent: 2.5, color: null }, 5: { size: 0.93, indent: 3.5, color: null }, 6: { size: 0.93, indent: 4.5, color: null },
    },
    colors: { light: {}, dark: {} },
    customCss: null,
  },
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
};

const REMOVED_KEYS = {
  source: 'le document est désormais déduit du nom : doc/<nom>.jsonc ↔ doc/<nom>.md',
  mediaDirs: 'les médias sont lus à côté du .md (doc/) et seuls ceux utilisés sont copiés dans output_html/<nom>/',
  outputDir: 'les sorties vont dans output_html/<nom>/ (HTML) et output_pdf/ (PDF)',
  title: 'déplacé dans la section "global" : global.title',
  icon: 'déplacé dans la section "global" : global.icon',
  language: 'déplacé dans la section "global" : global.language',
  htmlName: 'déplacé dans la section "html" : html.name',
  theme: 'déplacé dans la section "html" : html.theme',
  embedImages: 'déplacé dans la section "html" : html.embedImages',
  layout: 'sidebarWidth, sidebarMinWidth, sidebarMaxWidth et contentWidthPercent sont maintenant directement dans la section "html"',
};

const FONT_KINDS = ['headings', 'body', 'code', 'math'];

// Clés de "style" déplacées dans "global" (polices et taille de base).
const REMOVED_STYLE_KEYS = {
  fontFamily: 'global.fonts.body (et global.fonts.headings pour les titres)',
  codeFontFamily: 'global.fonts.code',
  fontSize: 'global.fontScale (en %, 100 = 16 px)',
};

// Nom de fichier sans extension (htmlName, pdf.name) : pas de dossier ni de caractère interdit sous Windows.
function fileStem(value, label, ext) {
  const v = String(value).replace(new RegExp(`\\${ext}$`, 'i'), '');
  if (!v || /[\\/:*?"<>|]/.test(v) || /^\.|[. ]$|[\u0000-\u001f]/.test(v)) throw new ConfigError(`${label} : nom de fichier invalide "${value}" (sans dossier ni caractères interdits sous Windows)`);
  return v;
}

// ---------- configuration ----------
function loadConfig(doc) {
  const user = doc.user;
  for (const [k, hint] of Object.entries(REMOVED_KEYS)) if (k in user) throw new ConfigError(`"${k}" n'existe plus : ${hint}`);
  if (isObj(user.pdf) && 'output' in user.pdf) throw new ConfigError('"pdf.output" n\'existe plus : utilisez "pdf.name" (nom du fichier, le PDF est écrit dans output_pdf/)');
  if (isObj(user.style)) {
    for (const [k, hint] of Object.entries(REMOVED_STYLE_KEYS)) if (k in user.style) throw new ConfigError(`"style.${k}" n'existe plus : utilisez ${hint}`);
  }
  const cfg = merge(DEFAULTS, user);
  cfg.docName = doc.name;
  cfg.sourcePath = doc.mdPath;
  cfg.configPath = doc.configPath;
  for (const key of ['global', 'html']) if (!isObj(cfg[key])) throw new ConfigError(`${key} doit être un objet`);
  const unknownKeys = (section) => {
    const extra = Object.keys(cfg[section]).filter((k) => !(k in DEFAULTS[section]));
    if (extra.length) throw new ConfigError(`${section} : clé(s) inconnue(s) : ${extra.join(', ')} (valides : ${Object.keys(DEFAULTS[section]).join(', ')})`);
  };
  unknownKeys('global');
  unknownKeys('html');
  const { html } = cfg;
  for (const key of ['sidebarWidth', 'sidebarMinWidth', 'sidebarMaxWidth', 'contentWidthPercent']) {
    if (typeof html[key] !== 'number' || !Number.isFinite(html[key])) {
      throw new ConfigError(`html.${key} doit être un nombre fini`);
    }
  }
  if (html.sidebarMinWidth < 0 || html.sidebarWidth < html.sidebarMinWidth
    || html.sidebarMaxWidth < html.sidebarWidth || html.contentWidthPercent < 0
    || html.contentWidthPercent > 100) {
    throw new ConfigError('html : vérifiez les bornes sidebarMinWidth ≤ sidebarWidth ≤ sidebarMaxWidth et contentWidthPercent entre 0 et 100');
  }
  if (!Number.isInteger(html.tocOpenLevel) || html.tocOpenLevel < 1 || html.tocOpenLevel > 6) {
    throw new ConfigError(`html.tocOpenLevel doit être un entier de 1 à 6 (reçu ${JSON.stringify(html.tocOpenLevel)})`);
  }
  if (typeof html.embedImages !== 'boolean') throw new ConfigError(`html.embedImages doit valoir true ou false (reçu ${JSON.stringify(html.embedImages)})`);
  if (typeof cfg.global.language !== 'string' || !cfg.global.language.trim()) throw new ConfigError('global.language doit être un code langue (ex. "fr")');
  for (const key of ['title', 'icon']) {
    if (cfg.global[key] != null && typeof cfg.global[key] !== 'string') throw new ConfigError(`global.${key} doit être un texte ou null`);
  }
  const percent = (label, v, min, max) => {
    if (!(typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max)) throw new ConfigError(`${label} doit être un nombre en % entre ${min} et ${max} (reçu ${JSON.stringify(v)})`);
  };
  percent('global.fontScale', cfg.global.fontScale, 25, 400);
  percent('global.zoom', cfg.global.zoom, 10, 200);
  percent('pdf.fontScale', cfg.pdf.fontScale, 25, 400);
  const checkFonts = (label, fonts, nullable) => {
    if (!isObj(fonts)) throw new ConfigError(`${label} doit être un objet { headings, body, code, math }`);
    for (const [k, v] of Object.entries(fonts)) {
      if (!FONT_KINDS.includes(k)) throw new ConfigError(`${label} : clé inconnue "${k}" (valides : ${FONT_KINDS.join(', ')})`);
      if (v == null && (nullable || k === 'headings' || k === 'math')) continue;
      if (typeof v !== 'string' || !v.trim() || /[;{}<>\\]/.test(v)) throw new ConfigError(`${label}.${k} doit être une liste de polices CSS (ex. "Georgia, serif"), sans ; { } < > \\${nullable || k === 'headings' || k === 'math' ? ' ou null' : ''}`);
    }
  };
  checkFonts('global.fonts', cfg.global.fonts, false);
  checkFonts('pdf.fonts', cfg.pdf.fonts, true);
  if (!isObj(cfg.style)) throw new ConfigError('style doit être un objet');
  if (!['auto', 'light', 'dark'].includes(html.theme)) throw new ConfigError(`html.theme doit valoir auto, light ou dark (reçu "${html.theme}")`);
  for (const key of ['pageTheme', 'pagePalettes', 'codeTheme', 'highlight']) {
    if (!isObj(cfg.style[key])) throw new ConfigError(`style.${key} doit être un objet`);
  }
  for (const key of ['headings', 'toc', 'colors', 'mermaid']) {
    if (!isObj(cfg.style[key])) throw new ConfigError(`style.${key} doit être un objet`);
  }
  for (const mode of ['light', 'dark']) {
    if (!isObj(cfg.style.colors[mode])) throw new ConfigError(`style.colors.${mode} doit être un objet`);
    for (const [key, value] of Object.entries(cfg.style.colors[mode])) {
      if (!COLOR_VARS[key]) throw new ConfigError(`style.colors.${mode} : clé inconnue "${key}" (valides : ${Object.keys(COLOR_VARS).join(', ')})`);
      if (typeof value !== 'string') throw new ConfigError(`style.colors.${mode}.${key} doit être une couleur CSS`);
    }
  }
  if (!['auto', 'light', 'dark', 'follow'].includes(cfg.style.codeTheme.mode)) {
    throw new ConfigError(`style.codeTheme.mode doit valoir auto, light, dark ou follow (reçu "${cfg.style.codeTheme.mode}")`);
  }
  if (typeof cfg.style.codeLanguage !== 'boolean') {
    throw new ConfigError(`style.codeLanguage doit valoir true ou false (reçu ${JSON.stringify(cfg.style.codeLanguage)})`);
  }
  const paletteNames = new Set(['default', 'formal', 'neon', ...Object.keys(cfg.style.pagePalettes)]);
  for (const mode of ['light', 'dark']) {
    if (typeof cfg.style.pageTheme[mode] !== 'string' || !paletteNames.has(cfg.style.pageTheme[mode])) {
      throw new ConfigError(`style.pageTheme.${mode} : palette inconnue "${cfg.style.pageTheme[mode]}". Palettes disponibles : ${[...paletteNames].join(', ')}`);
    }
  }
  for (const [name, palette] of Object.entries(cfg.style.pagePalettes)) {
    if (!isObj(palette)) throw new ConfigError(`style.pagePalettes.${name} doit être un objet de couleurs`);
    for (const [key, value] of Object.entries(palette)) {
      if (!COLOR_VARS[key]) throw new ConfigError(`style.pagePalettes.${name} : clé inconnue "${key}" (valides : ${Object.keys(COLOR_VARS).join(', ')})`);
      if (typeof value !== 'string') throw new ConfigError(`style.pagePalettes.${name}.${key} doit être une couleur CSS`);
    }
  }
  cfg.outputDir = path.join(HTML_OUTPUT_DIR, doc.name);
  cfg.outputFile = path.join(cfg.outputDir, `${fileStem(cfg.html.name, 'html.name', '.html')}.html`);
  try { validatePdfConfig(cfg.pdf); } catch (e) { throw new ConfigError(e.message); }
  // Réglages effectifs : le HTML suit global ; le PDF combine global et ses réglages d'affinement.
  const pdfZoom = Math.round(cfg.global.zoom * cfg.pdf.zoom) / 100;
  if (pdfZoom < 10 || pdfZoom > 200) throw new ConfigError(`zoom du PDF : global.zoom × pdf.zoom = ${pdfZoom} %, doit rester entre 10 et 200 % (global.zoom ${cfg.global.zoom} %, pdf.zoom ${cfg.pdf.zoom} %)`);
  const pdfFonts = { ...cfg.global.fonts };
  for (const k of FONT_KINDS) if (cfg.pdf.fonts[k] != null) pdfFonts[k] = cfg.pdf.fonts[k];
  cfg.render = {
    html: { fontScale: cfg.global.fontScale, zoom: cfg.global.zoom, fonts: cfg.global.fonts },
    pdf: { fontScale: Math.round(cfg.global.fontScale * cfg.pdf.fontScale) / 100, zoom: pdfZoom, fonts: pdfFonts },
  };
  cfg.pdfFile = path.join(PDF_OUTPUT_DIR, `${cfg.pdf.name == null ? doc.name : fileStem(cfg.pdf.name, 'pdf.name', '.pdf')}.pdf`);
  const bad = (m) => { throw new ConfigError(`style.mermaid : ${m}`); };
  cfg.style.mermaid = normalizeMermaidOptions(cfg.style.mermaid, bad);
  for (const part of ['headings', 'toc']) {
    for (const [lvl, o] of Object.entries(cfg.style[part])) {
      if (!/^[1-6]$/.test(lvl)) throw new ConfigError(`style.${part} : niveau "${lvl}" invalide (1 à 6)`);
      if (!isObj(o)) throw new ConfigError(`style.${part}.${lvl} doit être un objet`);
      for (const k of ['size', 'indent']) {
        if (!(typeof o[k] === 'number' && o[k] >= 0 && o[k] <= 20)) throw new ConfigError(`style.${part}.${lvl}.${k} doit être un nombre en em (0 à 20)`);
      }
      const c = o.color;
      const okColor = (v) => v == null || typeof v === 'string';
      if (!(okColor(c) || (isObj(c) && okColor(c.light) && okColor(c.dark)))) throw new ConfigError(`style.${part}.${lvl}.color : chaîne CSS ou { light, dark }`);
    }
  }
  return cfg;
}

// ---------- ressources ----------
const modDir = (name) => path.dirname(require.resolve(`${name}/package.json`));
const readAsset = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const esc = (s) => MarkdownIt().utils.escapeHtml(s);

// Mention de fin de page / de document.
const credit = (pdf) => `<footer class="mdable-credit">${pdf ? 'Document' : 'Site'} généré avec <a href="https://markdownable.benoitdekeyn.com">MarkDownAble</a></footer>`;

// Nom de fichier proposé au téléchargement quand le texte de <!-- code:… --> ressemble à "chemin/main.cpp" ; sinon ''.
function safeFileName(label) {
  const base = label.split(/[\\/]/).pop().trim();
  return /^[\p{L}\p{N}_.+\- ]*[\p{L}\p{N}_+\-]\.[A-Za-z0-9]{1,10}$/u.test(base) && !/^(con|prn|aux|nul|com\d|lpt\d)\./i.test(base) ? base : '';
}
const safeScript = (js) => js.replace(/<\/script/gi, '<\\/script');
const dataUri = (file) => `data:${MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'};base64,${fs.readFileSync(file).toString('base64')}`;

// Résout et préfixe une feuille de coloration syntaxique (highlight.js ou fichier personnalisé dans template/ ou doc/).
function scopedHljsCss(name, scope, configDir) {
  if (name === 'default') name = scope.includes('light') ? 'github' : 'github-dark';
  let file = null;
  if (configDir && fs.existsSync(path.resolve(configDir, name))) {
    file = path.resolve(configDir, name);
  } else if (fs.existsSync(path.resolve(TEMPLATE_DIR, name))) {
    file = path.resolve(TEMPLATE_DIR, name);
  } else if (fs.existsSync(path.resolve(TEMPLATE_DIR, `${name}.css`))) {
    file = path.resolve(TEMPLATE_DIR, `${name}.css`);
  } else if (fs.existsSync(path.resolve(TEMPLATE_DIR, `${name}.min.css`))) {
    file = path.resolve(TEMPLATE_DIR, `${name}.min.css`);
  } else {
    const hljsDir = path.join(modDir('highlight.js'), 'styles');
    const fMin = path.join(hljsDir, `${name}.min.css`);
    const fCss = path.join(hljsDir, `${name}.css`);
    if (fs.existsSync(fMin)) file = fMin;
    else if (fs.existsSync(fCss)) file = fCss;
  }

  if (!file) {
    const hljsDir = path.join(modDir('highlight.js'), 'styles');
    const all = fs.readdirSync(hljsDir).filter((f) => f.endsWith('.min.css')).map((f) => f.replace('.min.css', ''));
    throw new ConfigError(`Thème de code "${name}" introuvable. Disponibles : ${all.join(', ')} (ou indiquez un fichier .css de template/ ou doc/)`);
  }

  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/([^{}]+)\{([^{}]*)\}/g, (_, sel, body) => {
      const selectors = sel.split(',').map((s) => s.trim());
      // Un thème de code ne modifie que les couleurs, pas la police ni le cadre du bloc.
      body = body.split(';').filter((d) => /^\s*color\s*:/.test(d)).join(';');
      return `${selectors.map((s) => `${scope} ${s}`).join(',')}{${body}}`;
    });
}

// template/highlight.css permet de surcharger les couleurs des balises de code pour tous les documents.
// Les marqueurs /* @light */ et /* @dark */ séparent les règles pour chaque thème.
function highlightCustomCss() {
  const file = path.join(TEMPLATE_DIR, 'highlight.css');
  if (!fs.existsSync(file)) return '';
  let curScope = '';
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => {
      const m = /^\/\*\s*@(light|dark|all)\s*\*\/$/.exec(comment.trim());
      if (m) {
        curScope = m[1] === 'light' ? ':root[data-code-theme="light"] ' : m[1] === 'dark' ? ':root[data-code-theme="dark"] ' : '';
      }
      return '';
    })
    .replace(/([^{}]+)\{([^{}]*)\}/g, (_, sel, body) => {
      const selectors = sel.split(',').map((s) => s.trim()).filter(Boolean);
      if (!selectors.length || !body.trim()) return '';
      return `${selectors.map((s) => `${curScope}${s}`).join(',')}{${body}}`;
    });
}

// Règles CSS par niveau de titre. page : titres du document ; nav : liens du sommaire (base = --toc-size).
function levelRules(conf, kind) {
  const colorOf = (c) => (isObj(c) ? c : { light: c, dark: c });
  let css = '';
  for (const [lvl, o] of Object.entries(conf)) {
    const { light, dark } = colorOf(o.color);
    if (kind === 'page') {
      const sel = `.markdown-body h${lvl}`;
      css += `${sel}{font-size:${o.size}em;margin-left:${o.indent}em}\n`;
      if (light) css += `:root ${sel}{color:${light}}\n`;
      if (dark) css += `:root[data-theme="dark"] ${sel}{color:${dark}}\n`;
    } else {
      const link = `#toc a.toc-l${lvl}`;
      css += `${link}{font-size:calc(var(--toc-size)*${o.size})}\n#toc .row-l${lvl}{padding-left:calc(var(--toc-size)*${o.indent})}\n`;
      if (light) css += `:root ${link}:not(.active){color:${light}}\n`;
      if (dark) css += `:root[data-theme="dark"] ${link}:not(.active){color:${dark}}\n`;
    }
  }
  return css;
}

// template/mermaid.css est injecté dans chaque diagramme (option Mermaid « themeCSS »).
// Les marqueurs /* @light */ et /* @dark */ réservent les règles qui suivent à un thème de la page.
function mermaidCssSections() {
  const file = path.join(TEMPLATE_DIR, 'mermaid.css');
  const out = { common: '', light: '', dark: '' };
  if (!fs.existsSync(file)) return out;
  let cur = 'common';
  for (const part of fs.readFileSync(file, 'utf8').split(/(\/\*\s*@(?:light|dark|all)\s*\*\/)/)) {
    const m = /^\/\*\s*@(light|dark|all)\s*\*\/$/.exec(part);
    if (m) cur = m[1] === 'all' ? 'common' : m[1];
    else out[cur] += part;
  }
  return out;
}

function katexCss() {
  const dir = path.join(modDir('katex'), 'dist');
  return readAsset(dir, 'katex.min.css').replace(
    /url\(fonts\/([^)]+?)\.woff2\) format\("woff2"\),url\([^)]+\) format\("woff"\),url\([^)]+\) format\("truetype"\)/g,
    (_, name) => `url(${dataUri(path.join(dir, 'fonts', `${name}.woff2`))}) format("woff2")`,
  );
}

const COLOR_VARS = { bg: '--bg', fg: '--fg', muted: '--muted', border: '--border', sidebarBg: '--sidebar-bg', accent: '--accent', codeBg: '--code-bg', quote: '--quote' };
const BUILTIN_PAGE_PALETTES = {
  default: {},
  formal: {
    bg: '#ffffff', fg: '#202a35', muted: '#647080', border: '#cbd2d9',
    sidebarBg: '#f2f4f6', accent: '#244b70', codeBg: '#f1f3f5', quote: '#5e6872',
  },
  neon: {
    bg: '#0b0714', fg: '#f2eaff', muted: '#b89ad9', border: '#43245f',
    sidebarBg: '#130a20', accent: '#ff3df2', codeBg: '#150d24', quote: '#c6a9dc',
  },
};
function colorRules(colors, selector) {
  const decl = Object.entries(colors || {}).map(([k, v]) => {
    if (!COLOR_VARS[k]) throw new ConfigError(`style.colors : clé inconnue "${k}" (valides : ${Object.keys(COLOR_VARS).join(', ')})`);
    return `${COLOR_VARS[k]}:${v}`;
  });
  return decl.length ? `${selector}{${decl.join(';')}}\n` : '';
}
function pagePaletteRules(style) {
  let css = '';
  for (const mode of ['light', 'dark']) {
    const name = style.pageTheme[mode];
    if (name === 'default') continue;
    const palette = style.pagePalettes[name] || BUILTIN_PAGE_PALETTES[name];
    css += colorRules(palette, `:root[data-theme="${mode}"]`);
  }
  return css;
}

// ---------- Mermaid : mise en page et direction ----------
const MERMAID_LAYOUTS = { dagre: 'dagre', hierarchical: 'dagre', hierarchique: 'dagre', hiérarchique: 'dagre', elk: 'elk', adaptive: 'elk', adaptatif: 'elk' };
const MERMAID_DIRECTIONS = { tb: 'TB', td: 'TB', bt: 'BT', lr: 'LR', rl: 'RL' };

function normalizeMermaidOptions(raw, onError) {
  const out = {};
  if (raw.layout != null) {
    out.layout = MERMAID_LAYOUTS[String(raw.layout).toLowerCase()];
    if (!out.layout) { onError(`layout "${raw.layout}" inconnu (dagre/hierarchical ou elk/adaptive)`); delete out.layout; }
  }
  if (raw.direction != null) {
    out.direction = MERMAID_DIRECTIONS[String(raw.direction).toLowerCase()];
    if (!out.direction) { onError(`direction "${raw.direction}" inconnue (TB, BT, LR, RL)`); delete out.direction; }
  }
  return out;
}

function parseMermaidOptions(words, defaults, onError) {
  const raw = {};
  for (const w of words) {
    const m = /^(layout|direction)=(.+)$/i.exec(w);
    if (m) raw[m[1].toLowerCase()] = m[2];
    else onError(`option "${w}" ignorée (attendu layout=… ou direction=…)`);
  }
  return { ...normalizeMermaidOptions(defaults, () => {}), ...normalizeMermaidOptions(raw, onError) };
}

function applyMermaidOptions(src, opts, onWarn) {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  let start = 0;
  if (lines[0].trim() === '---') { // frontmatter YAML éventuel
    const end = lines.indexOf('---', 1);
    if (end > 0) start = end + 1;
  }
  if (opts.direction) {
    const h = lines.findIndex((l, i) => i >= start && l.trim() && !/^\s*%%/.test(l));
    const type = h >= 0 ? lines[h].trim() : '';
    if (/^(flowchart|graph)\b/.test(type)) {
      lines[h] = lines[h].replace(/^(\s*(?:flowchart|graph))(?:\s+(?:TB|TD|BT|LR|RL))?/, `$1 ${opts.direction === 'TB' ? 'TD' : opts.direction}`);
    } else if (/^stateDiagram(-v2)?\b/.test(type)) {
      const indent = (lines[h + 1] || '').match(/^\s*/)[0] || '    ';
      // Une ligne "direction" au premier niveau (hors état composite) est remplacée, sinon ajoutée.
      let depth = 0, top = -1;
      for (let i = h + 1; i < lines.length; i++) {
        if (depth === 0 && /^\s*direction\s+\w+\s*$/.test(lines[i])) { top = i; break; }
        if (/\{\s*$/.test(lines[i])) depth++;
        if (/^\s*\}/.test(lines[i])) depth--;
      }
      if (top >= 0) lines[top] = `${indent}direction ${opts.direction}`;
      else lines.splice(h + 1, 0, `${indent}direction ${opts.direction}`);
    } else {
      onWarn(`direction ignorée (types gérés : flowchart/graph, stateDiagram) ; type : "${type.split(/\s+/)[0]}"`);
    }
  }
  if (opts.layout === 'elk') lines.splice(start, 0, '%%{init: {"layout": "elk"}}%%');
  return lines.join('\n');
}

// Les modules ESM du plugin ELK sont regroupés en un script autonome (chargé seulement si un diagramme l'utilise).
async function elkBundle() {
  const { build } = await import('esbuild');
  const entry = path.join(modDir('@mermaid-js/layout-elk'), 'dist', 'mermaid-layout-elk.core.mjs');
  const res = await build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', globalName: '__elk', minify: true, platform: 'browser', logLevel: 'silent' });
  return res.outputFiles[0].text;
}

// ---------- rendu ----------
async function render(cfg, { pdf = false } = {}) {
  const warnings = [];
  const source = fs.readFileSync(cfg.sourcePath, 'utf8');

  const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
  md.use(texmath, { engine: katex, delimiters: 'dollars', katexOptions: { throwOnError: false, strict: 'ignore' } });
  // texmath rend « texte $$…$$ texte » avec <section>, élément de bloc qui ferme le <p> en cours dans le HTML :
  // le texte suivant se retrouvait alors hors de tout paragraphe. On garde un <span> (affiché en bloc par le CSS).
  for (const name of ['math_inline_double']) {
    const rule = md.renderer.rules[name];
    if (rule) md.renderer.rules[name] = (...a) => rule(...a).replace(/^<section><eqn>([\s\S]*)<\/eqn><\/section>$/, '<span class="eqn-display">$1</span>');
  }

  // Listes de tâches « - [ ] » / « - [x] » : case à cocher non interactive, sans puce.
  md.core.ruler.push('task_lists', (state) => {
    const t = state.tokens;
    for (let i = 2; i < t.length; i++) {
      if (t[i].type !== 'inline' || t[i - 1].type !== 'paragraph_open' || t[i - 2].type !== 'list_item_open') continue;
      const m = /^\[([ xX])\][ \t]+/.exec(t[i].content);
      if (!m || !t[i].children?.length || t[i].children[0].type !== 'text') continue;
      const first = t[i].children[0];
      first.content = first.content.replace(/^\[[ xX]\][ \t]+/, '');
      t[i].content = t[i].content.slice(m[0].length);
      const box = new state.Token('html_inline', '', 0);
      const done = m[1] !== ' ';
      box.content = `<span class="task-box${done ? ' checked' : ''}" role="img" aria-label="${done ? 'fait' : 'à faire'}"></span>`;
      t[i].children.unshift(box);
      t[i - 2].attrJoin('class', 'task-item');
      for (let j = i - 3; j >= 0; j--) {
        if (t[j].type === 'bullet_list_open' || t[j].type === 'ordered_list_open') { t[j].attrJoin('class', 'task-list'); break; }
      }
    }
  });

  // Commandes d'impression : "\newpage" (saut de page) et "\nohf" (page sans en-tête/pied), seules sur leur ligne,
  // ou leur équivalent en commentaire HTML (<!-- newpage -->, <!-- nohf -->) invisible sur GitHub.
  md.core.ruler.push('pagebreak', (state) => {
    const t = state.tokens;
    const markers = (cmds) => cmds.map((c) => {
      const k = new state.Token('html_block', '', 0);
      k.content = `<div class="${c === 'nohf' ? 'nohf' : c === 'samepage' ? 'samepage' : 'pagebreak'}"></div>\n`;
      return k;
    });
    const kind = (s) => (/^nohf$/i.test(s) ? 'nohf' : /^samepage$/i.test(s) ? 'samepage' : 'pagebreak');
    // Ligne de tableau ne contenant que « \newpage » : elle est retirée et la ligne suivante commence une nouvelle page.
    for (let i = 0; i < t.length; i++) {
      if (t[i].type !== 'tr_open') continue;
      let j = i + 1;
      const cells = [];
      while (t[j] && t[j].type !== 'tr_close') {
        if (t[j].type === 'inline') cells.push(t[j].content.trim());
        j++;
      }
      if (!cells.length || !/^\\(newpage|pagebreak|clearpage)$/i.test(cells[0]) || cells.slice(1).some(Boolean)) continue;
      let next = j + 1;
      while (t[next] && t[next].type !== 'tr_open' && t[next].type !== 'tbody_close') next++;
      if (t[next]?.type === 'tr_open') t[next].attrJoin('class', 'pb');
      t.splice(i, j - i + 1);
      i--;
    }
    for (let i = 0; i < t.length; i++) {
      if (t[i].type === 'html_block') {
        t[i].content = t[i].content.replace(/^[ \t]*\\(newpage|pagebreak|clearpage|nohf|samepage)[ \t]*$/gim, (_, c) => `<div class="${kind(c) === 'pagebreak' ? 'pagebreak' : kind(c)}"></div>`);
        const found = t[i].content.match(/<!--\s*(?:newpage|pagebreak|nohf|samepage)\s*-->/gi);
        if (found && t[i].content.replace(/<!--\s*(?:newpage|pagebreak|nohf|samepage)\s*-->/gi, '').trim() === '') {
          const ms = markers(found.map((f) => kind(f.replace(/<!--\s*|\s*-->/g, ''))));
          t.splice(i, 1, ...ms);
          i += ms.length - 1;
        }
      } else if (t[i].type === 'paragraph_open' && t[i + 1]?.type === 'inline' && t[i + 2]?.type === 'paragraph_close') {
        const raw = t[i + 1].content.split('\n');
        const isMarker = (l) => /^\\(newpage|pagebreak|clearpage|nohf|samepage)$/i.test(l.trim());
        if (raw.some(isMarker)) {
          // Un marqueur au milieu d'un paragraphe (ex. dans la table des matières) le coupe en plusieurs morceaux.
          const out = [];
          let buf = [];
          const flushText = () => {
            if (!buf.length) return;
            const open = new state.Token('paragraph_open', 'p', 1);
            const inl = new state.Token('inline', '', 0);
            inl.content = buf.join('\n');
            inl.children = [];
            state.md.inline.parse(inl.content, state.md, state.env, inl.children);
            out.push(open, inl, new state.Token('paragraph_close', 'p', -1));
            buf = [];
          };
          for (const l of raw) {
            if (isMarker(l)) { flushText(); out.push(...markers([kind(l.trim().slice(1))])); } else buf.push(l);
          }
          flushText();
          t.splice(i, 3, ...out);
          i += out.length - 1;
        }
      }
    }
  });

  // Marqueur <!-- code:lang -->, <!-- code:nolang --> ou <!-- code:texte libre --> placé juste avant un bloc de code :
  // il règle l'étiquette de CE bloc (invisible sur GitHub et à l'écran car c'est un commentaire HTML).
  md.core.ruler.push('code_label', (state) => {
    const t = state.tokens;
    const MARK = /^\s*<!--\s*code:([\s\S]*?)-->\s*$/i;
    let pending = null;
    for (let i = 0; i < t.length; i++) {
      const tok = t[i];
      if (tok.type === 'html_block' && /^\s*<!--\s*code:/i.test(tok.content)) {
        const m = tok.content.match(MARK);
        if (!m || m[1].includes('-->') || m[1].includes('<!--')) {
          warnings.push(`balise "${tok.content.trim().split('\n')[0]}" ignorée : elle doit tenir seule sur sa ligne (<!-- code:lang -->, <!-- code:nolang --> ou <!-- code:texte -->)`);
          continue;
        }
        const value = m[1].trim();
        if (pending) warnings.push(`ligne ${(tok.map?.[0] ?? 0) + 1} : deux balises <!-- code:… --> de suite, seule la dernière est prise en compte`);
        pending = { value, line: (tok.map?.[0] ?? 0) + 1 };
        t.splice(i, 1);
        i--;
        continue;
      }
      if (!pending) continue;
      const p = pending;
      pending = null;
      if (tok.type !== 'fence') {
        warnings.push(`ligne ${p.line} : <!-- code:${p.value} --> n'est pas suivi directement d'un bloc de code, il est ignoré`);
        continue;
      }
      const lang = tok.info.trim().split(/\s+/)[0].toLowerCase();
      if (lang === 'mermaid') {
        warnings.push(`ligne ${p.line} : <!-- code:${p.value} --> ne s'applique pas aux diagrammes Mermaid, il est ignoré`);
        continue;
      }
      const mode = p.value.toLowerCase();
      if (!p.value) warnings.push(`ligne ${p.line} : <!-- code: --> est vide (attendu : lang, nolang ou un texte), il est ignoré`);
      else if (mode === 'nolang') tok.meta = { ...tok.meta, showLang: false };
      else if (mode === 'lang') {
        if (!lang) warnings.push(`ligne ${p.line} : <!-- code:lang --> mais le bloc de code n'indique aucun langage`);
        tok.meta = { ...tok.meta, showLang: true };
      } else tok.meta = { ...tok.meta, label: p.value.replace(/\s+/g, ' ') };
    }
    if (pending) warnings.push(`ligne ${pending.line} : <!-- code:${pending.value} --> n'est suivi d'aucun bloc de code, il est ignoré`);
  });

  let hasMermaid = false;
  let usesElk = false;
  let mermaidCount = 0;
  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const lang = token.info.trim().split(/\s+/)[0].toLowerCase();
    if (lang === 'mermaid') {
      hasMermaid = true;
      const where = `diagramme Mermaid n°${++mermaidCount}`;
      const opts = parseMermaidOptions(token.info.trim().split(/\s+/).slice(1), cfg.style.mermaid, (m) => warnings.push(`${where} : ${m}`));
      if (opts.layout === 'elk') usesElk = true;
      return `<div class="mermaid-box"><pre class="mermaid">${esc(applyMermaidOptions(token.content, opts, (m) => warnings.push(`${where} : ${m}`)))}</pre></div>\n`;
    }
    let body;
    if (lang && hljs.getLanguage(lang)) body = hljs.highlight(token.content, { language: lang, ignoreIllegals: true }).value;
    else {
      if (lang) warnings.push(`langage de code inconnu : "${lang}"`);
      body = esc(token.content);
    }
    const label = token.meta?.label || (token.meta?.showLang ?? cfg.style.codeLanguage ? lang : '');
    const custom = !!token.meta?.label;
    const filename = custom ? safeFileName(label) : '';
    const lines = Math.max(1, token.content.replace(/\n$/, '').split('\n').length);
    const btn = (cls, text) => `<button class="${cls}" type="button" title="${text}" aria-label="${text}"></button>`;
    const buttons = [btn('copy-btn', 'Copier le code'), btn('expand-btn', 'Agrandir le code'), btn('download-btn', 'Télécharger le code')];
    const labelHtml = label ? `<span class="code-lang${custom ? ' custom' : ''}" title="${esc(label)}">${esc(label)}</span>` : '';
    let bar = '';
    let side = '';
    if (label) {
      const actions = pdf ? '' : `<div class="code-actions">${buttons.join('')}</div>`;
      bar = `<div class="code-bar">${actions}${labelHtml}</div>`;
    } else if (!pdf) {
      // Sans libellé : colonne de boutons à droite ; sur un code très court, seuls les boutons utiles apparaissent.
      side = `<div class="code-side"><div class="code-actions">${buttons.slice(0, Math.min(lines, 3)).join('')}</div></div>`;
    }
    const attrs = `${lang ? ` data-lang="${esc(lang)}"` : ''}${filename ? ` data-filename="${esc(filename)}"` : ''}`;
    return `<div class="code-block"><div class="code-frame${side ? ' side' : ''}"${attrs}>${bar}<pre><code class="hljs${lang ? ` language-${esc(lang)}` : ''}">${body}</code></pre>${side}</div></div>\n`;
  };

  // Identifiants de titres identiques à ceux de GitHub, pour que les liens [..](#...) marchent pareil.
  const slugger = new GithubSlugger();
  const headings = [];
  md.core.ruler.push('heading_ids', (state) => {
    const toks = state.tokens;
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type !== 'heading_open') continue;
      const inline = toks[i + 1];
      const text = (inline.children || [])
        .filter((t) => t.type === 'text' || t.type === 'code_inline')
        .map((t) => t.content).join('').trim();
      const id = slugger.slug(text);
      toks[i].attrSet('id', id);
      headings.push({ level: Number(toks[i].tag.slice(1)), text, id });
      const link = new state.Token('html_inline', '', 0);
      link.content = `<a class="anchor" href="#${id}" aria-label="Lien vers cette section">#</a>`;
      inline.children.push(link);
    }
  });

  const sourceName = path.basename(cfg.sourcePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const selfRef = new RegExp(`^(\\./)?${sourceName}(?=#|$)`, 'i');
  const internalLinks = [];
  md.core.ruler.push('links', (state) => {
    const walk = (tokens) => {
      for (const t of tokens) {
        if (t.type === 'link_open') {
          let href = (t.attrGet('href') || '').replace(selfRef, '');
          t.attrSet('href', href || '#');
          if (href.startsWith('#')) internalLinks.push(href);
          else if (/^https?:\/\//i.test(href)) {
            t.attrSet('target', '_blank');
            t.attrSet('rel', 'noopener noreferrer');
          }
        }
        if (t.children) walk(t.children);
      }
    };
    walk(state.tokens);
  });

  let body = md.render(source);
  const hasMath = /class="katex/.test(body);

  // Vérifications : ancres internes et fichiers locaux (relatifs au .md)
  const baseDir = path.dirname(cfg.sourcePath);
  const ids = new Set(headings.map((h) => h.id));
  for (const href of new Set(internalLinks)) {
    let id = href.slice(1);
    try { id = decodeURIComponent(id); } catch { /* fragment déjà brut */ }
    if (id && !ids.has(id)) warnings.push(`lien interne cassé : ${href}`);
  }
  const localFile = (ref) => {
    if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) return null;
    let f = ref.split(/[?#]/)[0];
    try { f = decodeURIComponent(f); } catch { /* ignore */ }
    return f ? path.resolve(baseDir, f) : null;
  };
  for (const m of body.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    const file = localFile(m[1]);
    if (file && !fs.existsSync(file)) {
      warnings.push(`lien local introuvable : "${m[1]}" (résolu depuis ${rel(cfg.sourcePath)} vers ${rel(file)} ; les liens sont relatifs au dossier des documents, ${rel(DOC_DIR)}/)`);
    }
  }
  if (cfg.html.embedImages) {
    body = body.replace(/(<img\b[^>]*?\bsrc=")([^"]+)(")/g, (all, a, ref, z) => {
      const file = localFile(ref);
      if (!file || !fs.existsSync(file)) return all;
      return `${a}${dataUri(file)}${z}`;
    });
  }

  // Les ressources déjà dans doc/media/ gardent leur chemin ; les autres vont dans media/linked/.
  const assets = new Map();
  const outputAssetPath = (relative) => {
    const normalized = relative.split(path.sep).join('/');
    return /^media\//i.test(normalized) ? `media/${normalized.slice(normalized.indexOf('/') + 1)}` : `media/linked/${normalized}`;
  };
  const addAsset = (relative) => {
    const outputPath = outputAssetPath(relative);
    const existing = assets.get(outputPath);
    if (existing && existing !== relative) {
      throw new ConfigError(`deux ressources locales entrent en conflit dans ${rel(cfg.outputDir)}/${outputPath}`);
    }
    assets.set(outputPath, relative);
    return outputPath;
  };
  if (!pdf) {
    for (const m of body.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
      const file = localFile(m[1]);
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile() || /\.md$/i.test(file)) continue;
      const r = path.relative(baseDir, file);
      if (r.startsWith('..') || path.isAbsolute(r)) warnings.push(`fichier situé hors de ${rel(DOC_DIR)}/, il ne sera pas copié dans ${rel(HTML_OUTPUT_DIR)}/ : ${m[1]}`);
      else addAsset(r);
    }
    body = body.replace(/(\b(?:src|href)=")([^"]+)(")/g, (all, before, ref, after) => {
      const file = localFile(ref);
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile() || /\.md$/i.test(file)) return all;
      const relative = path.relative(baseDir, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return all;
      const outputPath = addAsset(relative);
      const suffixAt = ref.search(/[?#]/);
      const suffix = suffixAt < 0 ? '' : ref.slice(suffixAt);
      const url = outputPath.split('/').map(encodeURIComponent).join('/');
      return `${before}${url}${suffix}${after}`;
    });
  }

  // Icône (favicon + logo du sommaire) : fichier de doc/ (ex. media/logo.png), copié avec les autres médias.
  let iconSrc = null;
  if (cfg.global.icon && !pdf) {
    const file = localFile(String(cfg.global.icon));
    const r = file && path.relative(baseDir, file);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) warnings.push(`global.icon : fichier introuvable : ${cfg.global.icon}`);
    else if (r.startsWith('..') || path.isAbsolute(r)) warnings.push(`global.icon : le fichier doit se trouver dans ${rel(DOC_DIR)}/ : ${cfg.global.icon}`);
    else if (cfg.html.embedImages) iconSrc = dataUri(file);
    else { iconSrc = outputAssetPath(r); addAsset(r); }
  }

  const title = cfg.global.title || path.parse(cfg.sourcePath).name;
  const sidebar = pdf ? '' : renderSidebar(headings);

  const { style, html: layout } = cfg;
  const render = pdf ? cfg.render.pdf : cfg.render.html;
  const clientCfg = {
    zoom: pdf ? 1 : render.zoom / 100,
    key: `markdown-doc:${path.parse(cfg.sourcePath).name}`,
    sidebarWidth: layout.sidebarWidth, sidebarMin: layout.sidebarMinWidth, sidebarMax: layout.sidebarMaxWidth,
    tocOpenLevel: layout.tocOpenLevel,
    codeThemeMode: style.codeTheme.mode,
    mermaidTheme: style.mermaidTheme,
    mermaidCss: mermaidCssSections(),
  };
  const json = (o) => JSON.stringify(o).replace(/</g, '\\u003c');

  const css = [
    readAsset(TEMPLATE_DIR, 'style.css'),
    readAsset(TEMPLATE_DIR, 'print.css'),
    hasMath ? katexCss() : '',
    scopedHljsCss(style.highlight.light, ':root[data-code-theme="light"]', baseDir),
    scopedHljsCss(style.highlight.dark, ':root[data-code-theme="dark"]', baseDir),
    highlightCustomCss(),
    pagePaletteRules(style),
    levelRules(style.headings, 'page'),
    levelRules(style.toc, 'nav'),
    `:root{--sidebar-w:${layout.sidebarWidth}px;--content-pct:${layout.contentWidthPercent};--fs:${render.fontScale / 100};--font:${render.fonts.body};--heading-font:${render.fonts.headings || 'var(--font)'};--code-font:${render.fonts.code};--code-font-size:${style.codeFontSize}${pdf ? `;--pdf-fig-h:${pdfGeometry(cfg.pdf, render.zoom).figHeight}px` : ''}}\n`,
    render.fonts.math ? `.katex,.katex .mathnormal,.katex .mathit,.katex .mathrm,.katex .mathbf,.katex .textrm,.katex .textbf,.katex .textit{font-family:${render.fonts.math}}\n` : '',
    !pdf && render.zoom !== 100 ? `html{zoom:${render.zoom / 100}}\n` : '',
    colorRules(style.colors.light, ':root'),
    colorRules(style.colors.dark, ':root[data-theme="dark"]'),
    style.customCss ? readAsset(path.resolve(path.dirname(cfg.configPath), style.customCss)) : '',
  ].join('\n');

  const elkCode = usesElk ? await elkBundle() : '';
  const mermaidScripts = hasMermaid ? `<script>${safeScript(readAsset(modDir('mermaid'), 'dist', 'mermaid.min.js'))}</script>` : '';
  const elkScript = usesElk ? `<script>${safeScript(elkCode)}</script>` : '';

  if (pdf) {
    const html = `<!DOCTYPE html>
<html lang="${esc(cfg.global.language)}" class="pdf" data-theme="${cfg.pdf.theme}" data-mode="${cfg.pdf.theme}" data-code-mode="${style.codeTheme.mode}" data-code-theme="${style.codeTheme.mode === 'dark' ? 'dark' : style.codeTheme.mode === 'light' ? 'light' : cfg.pdf.theme}">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
${css}
</style>
</head>
<body>
<main id="content"><article class="markdown-body">
${body}
</article>${credit(true)}</main>
<script>window.__DOCUMENT__=${json(clientCfg)};window.__PDF__=${json({ breakLevels: cfg.pdf.pageBreakBefore, hideToc: cfg.pdf.hideToc, keepSections: cfg.pdf.keepSectionsTogether, keepBlocks: cfg.pdf.keepBlocksTogether })}</script>
${mermaidScripts}
${elkScript}
<script>${safeScript(readAsset(TEMPLATE_DIR, 'print.js'))}</script>
</body>
</html>
`;
    return { html, headings: headings.length, warnings: [...new Set(warnings)] };
  }

  const html = `<!DOCTYPE html>
<html lang="${esc(cfg.global.language)}" data-theme="light" data-mode="${cfg.html.theme}" data-code-mode="${style.codeTheme.mode}" data-code-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${iconSrc ? `<link rel="icon" href="${esc(iconSrc)}">\n` : ''}<script>(function(){var c=${json(clientCfg)},r=document.documentElement,m=${json(cfg.html.theme)},w;try{m=localStorage.getItem(c.key+':theme')||m;w=localStorage.getItem(c.key+':sidebar')}catch(e){}
r.dataset.mode=m;r.dataset.theme=(m==='dark'||(m==='auto'&&matchMedia('(prefers-color-scheme: dark)').matches))?'dark':'light';
var cm=c.codeThemeMode,cd=cm==='dark'||(cm==='follow'?r.dataset.theme==='dark':cm==='auto'&&matchMedia('(prefers-color-scheme: dark)').matches);r.dataset.codeTheme=cd?'dark':'light';
if(w)r.style.setProperty('--sidebar-w',Math.max(c.sidebarMin,Math.min(c.sidebarMax,+w))+'px')})()</script>
<style>
${css}
</style>
</head>
<body>
<button id="sidebar-toggle" type="button" aria-label="Afficher / masquer le sommaire">&#9776;</button>
<aside id="sidebar">
  <div class="sidebar-head"><div class="sidebar-title">${iconSrc ? `<img class="sidebar-logo" src="${esc(iconSrc)}" alt="">` : ''}<span>${esc(title)}</span></div><button id="theme-toggle" type="button" title="Changer le thème"></button></div>
  <input id="toc-filter" type="search" placeholder="Filtrer les titres…" autocomplete="off">
  <nav id="toc">${sidebar}</nav>
</aside>
<div id="resizer" role="separator" aria-orientation="vertical" title="Glisser pour redimensionner (double-clic : largeur initiale)"></div>
<main id="content"><article class="markdown-body">
${body}
</article>${credit(false)}</main>
<script>window.__DOCUMENT__=${json(clientCfg)}</script>
${hasMermaid ? `${mermaidScripts}\n<script>${safeScript(readAsset(modDir('svg-pan-zoom'), 'dist', 'svg-pan-zoom.min.js'))}</script>` : ''}
${elkScript}
<script>${safeScript(readAsset(TEMPLATE_DIR, 'app.js'))}</script>
${WATCH ? '<script>let v;setInterval(async()=>{try{const n=await (await fetch("/__build",{cache:"no-store"})).text();if(v&&v!==n)location.reload();v=n}catch{}},800)</script>' : ''}
</body>
</html>
`;
  return { html, headings: headings.length, warnings: [...new Set(warnings)], assets: [...assets] };
}

function renderSidebar(items) {
  const roots = [];
  const stack = [];
  for (const h of items) {
    const node = { ...h, kids: [] };
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    (stack.length ? stack[stack.length - 1].kids : roots).push(node);
    stack.push(node);
  }
  const caret = '<button class="toc-caret" type="button" tabindex="-1" aria-label="Déplier / replier"></button>';
  const html = (n, root) => `<div class="toc-node${root ? ' root' : ''}${n.kids.length ? ' has-kids' : ''}" data-level="${n.level}"><div class="toc-row row-l${n.level}">${n.kids.length ? caret : '<span class="toc-caret"></span>'}<a class="toc-l${n.level}" href="#${n.id}" data-id="${n.id}">${esc(n.text)}</a></div>${n.kids.length ? `<div class="toc-children">${n.kids.map((k) => html(k, false)).join('')}</div>` : ''}</div>`;
  return roots.map((n) => html(n, true)).join('');
}

async function generate(cfg, opts = {}) {
  const result = await render(cfg, opts);
  return { cfg, ...result };
}

// ---------- ouverture automatique ----------
// Les builds n'ouvrent rien par défaut : --open (ou MARKDOWN_OPEN=1) ouvre le résultat.
// Le mode --watch ouvre le navigateur par défaut ; --no-open (ou MARKDOWN_NO_OPEN=1) l'en empêche.
const NO_OPEN = process.argv.includes('--no-open') || Boolean(process.env.MARKDOWN_NO_OPEN);
const OPEN = !NO_OPEN && (process.argv.includes('--open') || Boolean(process.env.MARKDOWN_OPEN) || WATCH);
function openTarget(target) {
  if (!OPEN) return;
  let cmd;
  let args;
  let opts = { detached: true, stdio: 'ignore' };
  if (process.platform === 'win32') {
    cmd = 'cmd.exe'; args = ['/c', 'start', '""', `"${target}"`]; opts = { ...opts, windowsVerbatimArguments: true };
  } else if (process.platform === 'darwin') {
    cmd = 'open'; args = [target];
  } else {
    cmd = 'xdg-open'; args = [target];
  }
  try {
    const child = spawn(cmd, args, opts);
    child.on('error', (e) => log.warning(`ouverture impossible : ${e.message}`));
    child.unref();
  } catch (e) { log.warning(`ouverture impossible : ${e.message}`); }
}

// ---------- exécution ----------
const fail = (msg) => log.error(msg);
const isConfigError = (e) => e instanceof ConfigError;

// Documents à traiter : ceux de doc/ ayant un .jsonc valide (ou seulement ceux demandés en argument).
function prepare() {
  const { docs, problems } = discoverDocs(NAMES);
  const issues = problems.map((p) => `${p.name}${CONFIG_SUFFIX} : ${p.message} — document ignoré`);
  const jobs = [];
  for (const doc of docs) {
    try { jobs.push({ doc, cfg: loadConfig(doc) }); }
    catch (e) {
      if (!isConfigError(e)) throw e;
      issues.push(`${doc.name}${CONFIG_SUFFIX} : ${e.message} — document ignoré`);
    }
  }
  if (!jobs.length) throw new ConfigError(issues.length ? `aucun document valide :\n  ${issues.join('\n  ')}` : `aucun document à générer : il faut ${rel(DOC_DIR)}/<nom>.md et ${rel(DOC_DIR)}/<nom>${CONFIG_SUFFIX} valide`);
  return { jobs, issues };
}

function printRunSummary({ successes, issues, action }) {
  for (const result of successes) log.success(result.message);
  const warnings = issues.filter((issue) => issue.type === 'warning');
  const errors = issues.filter((issue) => issue.type === 'error');
  for (const issue of warnings) log.warning(issue.message);
  for (const issue of errors) log.error(issue.message);
  const status = errors.length ? log.error : log.success;
  const count = (n, singular, plural = `${singular}s`) => `${n} ${n === 1 ? singular : plural}`;
  const warningText = warnings.length ? `, ${count(warnings.length, 'avertissement')}` : '';
  const generated = `${count(successes.length, 'document', 'documents')} généré${successes.length === 1 ? '' : 's'}`;
  status(`${action} terminé : ${generated}, ${count(errors.length, 'erreur', 'erreurs')}${warningText}`);
}

// Deux documents ne peuvent pas écrire le même fichier.
function checkCollisions(jobs, pick, option) {
  const seen = new Map();
  for (const { doc, cfg } of jobs) {
    const key = pick(cfg).toLowerCase();
    if (seen.has(key)) throw new ConfigError(`${rel(pick(cfg))} serait écrit par « ${seen.get(key)} » et par « ${doc.name} » : donnez-leur un "${option}" différent dans leur .jsonc`);
    seen.set(key, doc.name);
  }
}

// Fichiers écrits dans output_html/<nom>/ (page + médias) : on en garde la liste pour supprimer plus tard ceux qui ne sont
// plus utilisés (seulement ceux que l'outil a lui-même écrits, jamais un autre fichier).
function copyAssets(cfg, assets) {
  let copied = 0;
  for (const [outputPath, sourcePath] of assets) {
    const from = path.join(path.dirname(cfg.sourcePath), sourcePath);
    const to = path.join(cfg.outputDir, outputPath);
    const s = fs.statSync(from);
    if (fs.existsSync(to) && fs.statSync(to).size === s.size && fs.statSync(to).mtimeMs >= s.mtimeMs) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    copied++;
  }
  return copied;
}
function syncManifest(cfg, used) {
  const manifestDir = path.join(STATE_DIR, 'html-output-manifests');
  const manifest = path.join(manifestDir, `document-${encodeURIComponent(cfg.docName)}.json`);
  let prev = [];
  try {
    const stored = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (!Array.isArray(stored) || stored.some((f) => typeof f !== 'string')) {
      throw new ConfigError(`état de sortie HTML invalide : ${rel(manifest)}`);
    }
    prev = stored;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      if (e instanceof ConfigError) throw e;
      throw new ConfigError(`état de sortie HTML illisible : ${rel(manifest)} (${e.message})`);
    }
  }
  const keep = new Set(used);
  for (const f of prev) {
    const file = path.resolve(cfg.outputDir, f);
    const relative = path.relative(cfg.outputDir, file);
    if (keep.has(f) || !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    if (!fs.existsSync(file)) continue;
    const outputRoot = fs.realpathSync(cfg.outputDir);
    const realFile = fs.realpathSync(file);
    const realRelative = path.relative(outputRoot, realFile);
    if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) continue;
    if (!fs.lstatSync(file).isFile()) continue;
    fs.rmSync(file);
    for (let d = path.dirname(file); d !== cfg.outputDir && fs.readdirSync(d).length === 0; d = path.dirname(d)) fs.rmdirSync(d);
  }
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(manifest, `${JSON.stringify([...keep].sort(), null, 2)}\n`);
}
async function buildFiles() {
  const { jobs, issues: prepIssues } = prepare();
  if (PDF) checkCollisions(jobs, (c) => c.pdfFile, 'pdf.name');
  const outputs = [];
  const issues = prepIssues.map((message) => ({ type: 'error', message }));
  for (const { cfg } of jobs) {
    try {
      await log.withSpinner(`${PDF ? 'Génération PDF' : 'Génération HTML'} : ${cfg.docName}`, async () => {
        if (PDF) {
          const { html, headings, warnings } = await generate(cfg, { pdf: true });
          const pdfWarnings = [];
          const r = await exportPdf({ cfg, html, ConfigError, warn: (m) => pdfWarnings.push(m) });
          warnings.push(...pdfWarnings);
          outputs.push({ path: cfg.pdfFile, message: `${cfg.docName} → ${rel(cfg.pdfFile)} (${r.pages} pages, ${r.bookmarks} signets, ${headings} titres)` });
          warnings.forEach((message) => issues.push({ type: 'warning', message: `${cfg.docName} : ${message}` }));
        } else {
          const { html, assets, headings, warnings } = await generate(cfg);
          fs.mkdirSync(cfg.outputDir, { recursive: true });
          fs.writeFileSync(cfg.outputFile, html);
          copyAssets(cfg, assets);
          syncManifest(cfg, [path.basename(cfg.outputFile), ...assets.map(([outputPath]) => outputPath)]);
          outputs.push({ path: cfg.outputFile, message: `${cfg.docName} → ${rel(cfg.outputFile)} (${headings} titres, ${assets.length} média(s))` });
          warnings.forEach((message) => issues.push({ type: 'warning', message: `${cfg.docName} : ${message}` }));
        }
      });
    } catch (e) {
      if (!isConfigError(e)) throw e;
      issues.push({ type: 'error', message: `${cfg.docName} : ${e.message}` });
    }
  }
  if (outputs.length) outputs.forEach(({ path: file }) => openTarget(file));
  printRunSummary({ successes: outputs, issues, action: PDF ? 'Export PDF' : 'Build HTML' });
  if (issues.some((issue) => issue.type === 'error')) process.exitCode = 1;
}

// Serveur local : les pages sont générées en mémoire, les médias sont lus directement dans doc/.
async function serve() {
  const states = new Map();
  let buildId = String(Date.now());
  let running = false;
  let again = false;
  const rebuild = async () => {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        let jobs = [];
        const issues = [];
        try {
          const prepared = prepare();
          jobs = prepared.jobs;
          issues.push(...prepared.issues.map((message) => ({ type: 'error', message })));
        } catch (e) { if (!isConfigError(e)) throw e; issues.push({ type: 'error', message: e.message }); }
        states.clear();
        const successes = [];
        for (const { doc, cfg } of jobs) {
          try {
            const result = await log.withSpinner(`Génération de l’aperçu : ${doc.name}`, () => generate(cfg));
            states.set(doc.name, result);
            successes.push({ message: `${doc.name} : aperçu prêt (${result.headings} titres)` });
            result.warnings.forEach((message) => issues.push({ type: 'warning', message: `${doc.name} : ${message}` }));
          }
          catch (e) {
            issues.push({ type: 'error', message: `${doc.name} : ${e.message}` });
            states.set(doc.name, { html: `<pre style="color:#c00;padding:2em">${esc(e.message)}</pre>` });
          }
        }
        printRunSummary({ successes, issues, action: 'Aperçu' });
        buildId = String(Date.now());
      } while (again);
    } finally { running = false; }
  };
  await rebuild();

  const send = (res, code, type, body) => { res.statusCode = code; res.setHeader('Content-Type', type); res.end(body); };
  const HTML = 'text/html; charset=utf-8';
  const shell = (body) => `<!DOCTYPE html><meta charset="utf-8"><title>Documents Markdown</title><body style="font:16px system-ui;padding:2em">${body}`;
  const server = http.createServer((req, res) => {
    let url;
    try { url = decodeURIComponent(req.url.split('?')[0]); } catch { return send(res, 400, 'text/plain', '400'); }
    if (url === '/__build') return send(res, 200, 'text/plain', buildId);
    if (!states.size) return send(res, 503, HTML, shell('Aucun document valide : voir le terminal.'));
    let name;
    let rest = url;
    if (states.size === 1) name = [...states.keys()][0];
    else {
      if (url === '/') return send(res, 200, HTML, shell(`<h1>Documents</h1><ul>${[...states.keys()].map((n) => `<li><a href="/${encodeURIComponent(n)}/">${esc(n)}</a></li>`).join('')}</ul>`));
      const m = /^\/([^/]+)(\/.*)?$/.exec(url);
      if (!m || !states.has(m[1])) return send(res, 404, 'text/plain', '404');
      if (!m[2]) { res.statusCode = 301; res.setHeader('Location', `/${encodeURIComponent(m[1])}/`); return res.end(); }
      [, name, rest] = m;
    }
    if (rest === '/' || rest === '/index.html') return send(res, 200, HTML, states.get(name).html);
    // Seuls les fichiers de doc/ sont servis (images, pdf…), jamais les fichiers cachés.
    const file = path.resolve(DOC_DIR, '.' + rest);
    const type = MIME[path.extname(file).toLowerCase()];
    const ok = file.startsWith(DOC_DIR + path.sep) && type && fs.existsSync(file) && fs.statSync(file).isFile()
      && !/node_modules|(^|[\\/])\./.test(path.relative(DOC_DIR, file)) && !isToolFile(DOC_DIR, file);
    if (!ok) return send(res, 404, 'text/plain', '404');
    res.setHeader('Content-Type', type);
    fs.createReadStream(file).pipe(res);
  });
  // Port occupé (ex. un autre « npm run dev » encore ouvert) : on essaie les ports suivants.
  let port = PORT;
  const MAX_TRIES = 20;
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && !process.env.PORT && port < PORT + MAX_TRIES) {
      log.warning(`port ${port} déjà utilisé ; essai du port ${port + 1}`);
      server.listen(++port, '127.0.0.1');
    } else if (e.code === 'EADDRINUSE') {
      fail(`le port ${port} est déjà utilisé. Fermez l'autre « npm run dev » ou choisissez un autre port : $env:PORT=4200; npm run dev`);
      process.exit(1);
    } else {
      fail(`serveur : ${e.message}`);
      process.exit(1);
    }
  });
  server.on('listening', () => {
    log.info(`Aperçu disponible : http://localhost:${port} (Ctrl+C pour arrêter)`);
    openTarget(`http://localhost:${port}`);
  });
  server.listen(port, '127.0.0.1');

  let timer;
  const trigger = () => { clearTimeout(timer); timer = setTimeout(rebuild, 250); };
  // On surveille les dossiers : certains éditeurs remplacent le fichier à la sauvegarde.
  const watchers = [];
  // Sorties générées (<output_html>/<nom>/… et <output_pdf>/*.pdf) : à ignorer si elles sont dans un dossier surveillé,
  // sinon chaque build relancerait un build.
  const isGenerated = (abs) => {
    const inHtml = path.relative(HTML_OUTPUT_DIR, abs);
    if (inHtml && !inHtml.startsWith('..') && !path.isAbsolute(inHtml)) {
      let names = [];
      try { names = fs.readdirSync(DOC_DIR).filter((n) => n.toLowerCase().endsWith(CONFIG_SUFFIX)).map((n) => n.slice(0, -CONFIG_SUFFIX.length).toLowerCase()); } catch {}
      if (names.includes(inHtml.split(/[\\/]/)[0].toLowerCase())) return true;
    }
    return /\.pdf$/i.test(abs) && path.dirname(abs).toLowerCase() === PDF_OUTPUT_DIR.toLowerCase();
  };
  const watchDirs = () => {
    watchers.splice(0).forEach((w) => w.close());
    for (const dir of [DOC_DIR, TEMPLATE_DIR]) {
      if (!fs.existsSync(dir)) continue;
      const w = fs.watch(dir, { recursive: true }, (_, f) => {
        if (!f) return trigger();
        const abs = path.join(dir, f);
        if (!/(^|[\\/])\./.test(f) && !isToolFile(dir, abs) && !isGenerated(abs)) trigger();
      });
      w.on('error', () => {});
      watchers.push(w);
    }
  };
  watchDirs();
  // Modifier paths.jsonc en cours d'aperçu : les nouveaux dossiers sont pris en compte sans redémarrer.
  // Un paths.jsonc invalide est signalé et les chemins précédents sont conservés.
  const pathsName = path.basename(PATHS_FILE);
  fs.watch(path.dirname(PATHS_FILE), (_, f) => {
    if (f !== pathsName) return;
    clearTimeout(pathsTimer);
    pathsTimer = setTimeout(() => {
      const before = DOC_DIR;
      try { reloadPaths(); } catch (e) {
        if (!isConfigError(e)) throw e;
        log.error(`${e.message} — anciens chemins conservés`);
        return;
      }
      log.info(`paths.jsonc relu : documents dans ${rel(DOC_DIR)}/${before === DOC_DIR ? '' : ' (changement de dossier)'}`);
      watchDirs();
      trigger();
    }, 250);
  });
}
let pathsTimer;

try {
  if (UNKNOWN_FLAGS.length) throw new ConfigError(`option(s) inconnue(s) : ${UNKNOWN_FLAGS.join(', ')}`);
  if (WATCH && PDF) throw new ConfigError('--watch et --pdf ne peuvent pas être utilisés ensemble');
  if (WATCH && (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535)) throw new ConfigError(`PORT doit être un entier entre 1 et 65535 (reçu "${process.env.PORT}")`);
  if (WATCH) await serve();
  else await buildFiles();
} catch (e) {
  if (!isConfigError(e)) throw e;
  fail(e.message);
  process.exit(1);
}
