// Numérotation des titres et génération de la table des matières Markdown (commandes `npm run edit:*`).
import MarkdownIt from 'markdown-it';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import GithubSlugger from 'github-slugger';
import { merge, isObj } from './jsonc.mjs';

const LEVELS = [1, 2, 3, 4, 5, 6];
const lv = (f) => Object.fromEntries(LEVELS.map((n) => [String(n), f(n)]));
export const STYLES = ['ignore', 'none', 'decimal', 'alpha', 'ALPHA', 'roman', 'ROMAN'];

export const OUTLINE_DEFAULTS = {
  numbering: {
    levels: lv((n) => ({ style: n === 2 || n === 3 ? 'decimal' : 'ignore', separator: '.', cumulative: true })),
  },
  toc: {
    range: [2, 3],
    summary: 'Table des matières',
    collapsible: false,
    collapsibleLevels: null,
    foldOffset: 2,
    open: false,
    levels: lv((n) => ({
      symbol: ['•', '•', '◦', '–', '·', '·'][n - 1],
      indent: [0, 0, 4, 8, 12, 16][n - 1],
      bold: n <= 2,
      italic: false,
      size: null,
      collapsible: false,
    })),
  },
};

// Fusionne avec les valeurs par défaut et vérifie ; lève une Error au message lisible.
export function resolveOutlineConfig(user) {
  const fail = (m) => { throw new Error(m); };
  // « none » / « ignore » sans séparateur explicite : pas de symbole (le séparateur par défaut « . » n'a pas de sens ici).
  const userNumbering = isObj(user?.numbering) && isObj(user.numbering.levels)
    ? { ...user.numbering, levels: Object.fromEntries(Object.entries(user.numbering.levels).map(([k, o]) => [k,
      isObj(o) && (o.style === 'none' || o.style === 'ignore') && !('separator' in o) ? { ...o, separator: '' } : o])) }
    : user?.numbering;
  const cfg = { numbering: merge(OUTLINE_DEFAULTS.numbering, userNumbering), toc: merge(OUTLINE_DEFAULTS.toc, user?.toc) };
  const check = (path, obj, spec) => {
    if (!isObj(obj)) fail(`${path} doit être un objet`);
    for (const [k, v] of Object.entries(obj)) {
      if (!(k in spec)) fail(`${path} : clé inconnue "${k}" (valides : ${Object.keys(spec).join(', ')})`);
      const err = spec[k](v);
      if (err) fail(`${path}.${k} ${err}`);
    }
  };
  const isBool = (v) => (typeof v === 'boolean' ? null : 'doit valoir true ou false');

  check('numbering', cfg.numbering, { levels: () => null });
  for (const [lvl, o] of Object.entries(cfg.numbering.levels)) {
    if (!/^[1-6]$/.test(lvl)) fail(`numbering.levels : niveau "${lvl}" invalide (1 à 6)`);
    check(`numbering.levels.${lvl}`, o, {
      style: (v) => (STYLES.includes(v) ? null : `doit valoir ${STYLES.join(', ')} (reçu "${v}")`),
      separator: (v) => (typeof v === 'string' ? null : 'doit être une chaîne (ex. ".", " ", "-")'),
      cumulative: isBool,
    });
  }

  check('toc', cfg.toc, {
    range: (r) => (Array.isArray(r) && r.length === 2 && r.every((n) => Number.isInteger(n) && n >= 1 && n <= 6) && r[0] <= r[1] ? null : 'doit être [min, max] avec 1 ≤ min ≤ max ≤ 6'),
    summary: (v) => (typeof v === 'string' ? null : 'doit être une chaîne'),
    collapsible: isBool,
    collapsibleLevels: (v) => (v === null || (Array.isArray(v) && v.every((n) => Number.isInteger(n) && n >= 1 && n <= 6)) ? null : 'doit être null ou un tableau de niveaux 1 à 6, ex. [2, 3]'),
    open: isBool,
    foldOffset: (v) => (Number.isInteger(v) && v >= 0 && v <= 20 ? null : 'doit être un entier de 0 à 20 (demi-cadratins)'),
    levels: () => null,
  });
  // Le tableau, s'il est fourni, l'emporte sur levels.N.collapsible.
  if (Array.isArray(cfg.toc.collapsibleLevels)) {
    cfg.toc = { ...cfg.toc, levels: Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [n, { ...cfg.toc.levels[n], collapsible: cfg.toc.collapsibleLevels.includes(n) }])) };
  }
  for (const [lvl, o] of Object.entries(cfg.toc.levels)) {
    if (!/^[1-6]$/.test(lvl)) fail(`toc.levels : niveau "${lvl}" invalide (1 à 6)`);
    check(`toc.levels.${lvl}`, o, {
      symbol: (v) => (typeof v === 'string' ? null : 'doit être une chaîne ("" = aucun symbole)'),
      indent: (v) => (Number.isInteger(v) && v >= 0 && v <= 60 ? null : 'doit être un entier ≥ 0 (nombre de demi-cadratins)'),
      bold: isBool,
      italic: isBool,
      size: (v) => (v === null || (typeof v === 'number' && v >= 0.3 && v <= 4) ? null : 'doit être null ou une taille en em (0.3 à 4)'),
      collapsible: isBool,
    });
  }
  return cfg;
}

// ---------- analyse du Markdown ----------
function makeParser() {
  return new MarkdownIt({ html: true }).use(texmath, { engine: katex, delimiters: 'dollars' });
}

// Titres, plages de blocs de code, retours à la ligne. Les slugs suivent exactement ceux de build.mjs (GitHub).
function scan(src) {
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  const tokens = makeParser().parse(src, {});
  const slugger = new GithubSlugger();
  const heads = [];
  const fences = [];
  tokens.forEach((t, i) => {
    if ((t.type === 'fence' || t.type === 'code_block') && t.map) fences.push(t.map);
    if (t.type !== 'heading_open') return;
    const inline = tokens[i + 1];
    const text = (inline.children || []).filter((c) => c.type === 'text' || c.type === 'code_inline').map((c) => c.content).join('').trim();
    heads.push({
      level: Number(t.tag.slice(1)),
      text,
      slug: slugger.slug(text),
      raw: inline.content,
      line: t.map[0],
      editable: t.markup.startsWith('#') && t.level === 0 && t.map[1] - t.map[0] === 1,
    });
  });
  const inFence = (i) => fences.some(([a, b]) => i >= a && i < b);
  return { eol, lines, heads, inFence };
}

// ---------- numérotation ----------
function toAlpha(n) {
  let s = '';
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(97 + ((k - 1) % 26)) + s;
  return s;
}
function toRoman(n) {
  const map = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let s = '';
  for (const [v, r] of map) while (n >= v) { s += r; n -= v; }
  return s;
}
function formatIndex(n, style) {
  if (n < 1) return String(n);
  switch (style) {
    case 'alpha': return toAlpha(n);
    case 'ALPHA': return toAlpha(n).toUpperCase();
    case 'roman': return toRoman(n);
    case 'ROMAN': return toRoman(n).toUpperCase();
    default: return String(n);
  }
}

const isIndexed = (style) => style !== 'none' && style !== 'ignore';

// « none » : pas d'indice, seul le séparateur est écrit devant le titre (ex. "▪" => "## ▪ Titre").
const symbolPrefix = (sep) => (sep.trim() ? (/\s$/.test(sep) ? sep : `${sep} `) : '');

function numberPrefix(level, st, counters) {
  const own = st[level];
  if (!isIndexed(own.style)) return symbolPrefix(own.separator);
  let s = '';
  for (let l = own.cumulative ? 1 : level; l <= level; l++) {
    if (!isIndexed(st[l].style)) continue;
    s += formatIndex(counters[l], st[l].style) + st[l].separator;
  }
  return /\s$/.test(s) ? s : `${s} `;
}

// ---------- lecture d'une numérotation existante ----------
const ROMAN_RE = /^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/;

// Styles possibles d'un indice écrit dans un titre.
function tokenStyles(tok) {
  if (/^\d+$/.test(tok)) return ['decimal'];
  const out = [];
  if (/^[a-z]{1,2}$/.test(tok)) out.push('alpha');
  if (/^[A-Z]{1,2}$/.test(tok)) out.push('ALPHA');
  if (/^[ivxlcdm]+$/.test(tok) && ROMAN_RE.test(tok)) out.push('roman');
  if (/^[IVXLCDM]+$/.test(tok) && ROMAN_RE.test(tok.toLowerCase())) out.push('ROMAN');
  return out;
}

// Numéro en début de titre : suite de « indice + séparateur » ("2.1. ", "A - ", "i) ", "3 "…) suivie du texte.
// Retourne les indices lus et la position du texte du titre.
function parsePrefix(raw) {
  const tokens = [];
  let pos = 0;
  const re = /^(\d+|[A-Za-z]{1,6})(\s*[^\p{L}\p{N}\s]+\s*|\s+)/u;
  for (;;) {
    const m = re.exec(raw.slice(pos));
    if (!m) break;
    const [all, tok, sep] = m;
    const punct = /\S/.test(sep);
    if (!tokenStyles(tok).length || (!punct && !(tokens.length === 0 && /^\d+$/.test(tok)))) break;
    pos += all.length;
    tokens.push({ tok, sep, end: pos });
    if (!punct) break; // séparateur fait d'espaces seuls : « 3 Titre » termine le numéro
  }
  while (tokens.length && !/\s$/.test(tokens[tokens.length - 1].sep) && tokens[tokens.length - 1].end < raw.length) tokens.pop();
  return { tokens, end: tokens.length ? tokens[tokens.length - 1].end : 0 };
}

// Séparateur tel qu'il s'écrit dans la config : l'espace unique qui suit « . » est ajouté automatiquement.
const normalizeSep = (sep) => (/^\S.*\s$/.test(sep) && !/\s\s$/.test(sep) ? sep.slice(0, -1) : sep);

// Retire du titre la numérotation (ou le symbole « none ») écrite avec le schéma `prevLevel` ; « ignore » ne touche à rien.
function stripNumber(raw, prevLevel) {
  const prevStyle = prevLevel?.style;
  if (!prevStyle || prevStyle === 'ignore') return raw;
  if (prevStyle === 'none') {
    const sym = prevLevel.separator.trim();
    return sym && raw.startsWith(sym) ? raw.slice(sym.length).trim() || raw : raw;
  }
  const { tokens, end } = parsePrefix(raw);
  if (!tokens.length || !tokenStyles(tokens[tokens.length - 1].tok).includes(prevStyle)) return raw;
  return raw.slice(end).trim() || raw;
}

const SCHEME = (style, separator) => () => lv(() => ({ style, separator, cumulative: false }));
const IGNORE_ALL = SCHEME('ignore', '.');
const NO_NUMBERING = SCHEME('none', '');

// Devine, niveau par niveau, la numérotation présente dans le document : le schéma majoritaire (au moins la moitié
// des titres du niveau) l'emporte, sinon le niveau est laissé en « ignore ». Un symbole commun en tête de titre
// ("▪ Titre") donne « none » + séparateur.
export function guessNumbering(src) {
  const { heads } = scan(src);
  const counters = [0, 0, 0, 0, 0, 0, 0];
  const per = Object.fromEntries(LEVELS.map((n) => [n, { total: 0, sigs: new Map() }]));
  const vote = (slot, sig) => slot.sigs.set(sig, (slot.sigs.get(sig) || 0) + 1);
  for (const h of heads) {
    if (!h.editable) continue;
    counters[h.level]++;
    for (let l = h.level + 1; l <= 6; l++) counters[l] = 0;
    const slot = per[h.level];
    slot.total++;
    const { tokens } = parsePrefix(h.raw);
    if (!tokens.length) {
      const sym = /^([^\p{L}\p{N}\s#]+)\s/u.exec(h.raw);
      if (sym) vote(slot, JSON.stringify(['none', sym[1], false]));
      continue;
    }
    const last = tokens[tokens.length - 1];
    const cands = tokenStyles(last.tok);
    // Lettres ambiguës (i, c, d…) : le style dont l'indice correspond au rang du titre l'emporte.
    const style = cands.find((c) => formatIndex(counters[h.level], c) === last.tok) || cands[0];
    vote(slot, JSON.stringify([style, normalizeSep(last.sep), tokens.length > 1]));
  }
  const levels = IGNORE_ALL();
  const detail = {};
  for (const n of LEVELS) {
    const { total, sigs } = per[n];
    const best = [...sigs.entries()].sort((a, b) => b[1] - a[1])[0];
    detail[n] = { total, numbered: [...sigs.values()].reduce((a, b) => a + b, 0) };
    if (best && best[1] * 2 >= total) {
      const [style, separator, cumulative] = JSON.parse(best[0]);
      levels[n] = { style, separator, cumulative };
    }
  }
  return { levels, detail };
}

// numbering.levels (clés "1".."6") fusionné avec des valeurs sûres, utilisable comme « ancien schéma ».
export function normalizeLevels(levels) {
  return Object.fromEntries(LEVELS.map((n) => [String(n), { ...IGNORE_ALL()[n], ...(levels?.[n] || {}) }]));
}

export function noNumbering() { return NO_NUMBERING(); }

// Applique le schéma `levels` aux titres. `previous` est le schéma actuellement écrit dans le document : c'est lui
// qui sert à retirer l'ancienne numérotation (niveaux passés à « none » compris, jamais ceux en « ignore »).
export function applyNumbering(src, levels, previous) {
  const { eol, lines, heads } = scan(src);
  const st = Object.fromEntries(Object.entries(levels).map(([k, v]) => [Number(k), v]));
  const prev = Object.fromEntries(Object.entries(previous).map(([k, v]) => [Number(k), v]));
  const counters = [0, 0, 0, 0, 0, 0, 0];
  const changes = [];
  const warnings = [];
  let skippedWarned = false;

  for (const h of heads) {
    if (!h.editable) {
      warnings.push(`ligne ${h.line + 1} : titre non modifiable (setext, multi-lignes ou imbriqué dans une citation/liste), ignoré : "${h.text}"`);
      continue;
    }
    counters[h.level]++;
    for (let l = h.level + 1; l <= 6; l++) counters[l] = 0;
    if (!skippedWarned && isIndexed(st[h.level].style)) {
      for (let l = st[h.level].cumulative ? 1 : h.level; l < h.level; l++) {
        if (isIndexed(st[l].style) && counters[l] === 0) {
          warnings.push(`ligne ${h.line + 1} : niveau de titre sauté (aucun titre de niveau ${l} avant celui-ci), l'indice affiché est 0`);
          skippedWarned = true;
          break;
        }
      }
    }
    if (st[h.level].style === 'ignore') continue;
    const bare = stripNumber(h.raw, prev[h.level]);
    const prefix = numberPrefix(h.level, st, counters);
    if (!prefix && bare === h.raw) continue; // rien à ajouter ni à retirer : le titre reste tel qu'écrit
    const next = `${'#'.repeat(h.level)} ${prefix}${bare.trim()}`;
    if (next !== lines[h.line]) {
      changes.push({ line: h.line + 1, from: lines[h.line], to: next });
      lines[h.line] = next;
    }
  }
  let text = lines.join(eol);
  if (!changes.length) return { text: src, changes, warnings };

  // Les liens internes (#ancre) vers les titres renumérotés suivent leur nouvelle ancre.
  const before = heads.map((h) => h.slug);
  const after = scan(text).heads.map((h) => h.slug);
  const map = new Map();
  if (before.length === after.length) before.forEach((s, i) => { if (s !== after[i]) map.set(s.toLowerCase(), after[i]); });
  let relinked = 0;
  text = text.replace(/(\]\(\s*#|href=["']#)([^)"'\s]*)/g, (m, pre, id) => {
    let dec = id;
    try { dec = decodeURIComponent(id); } catch { /* ancre déjà brute */ }
    const n = map.get(dec.toLowerCase());
    if (!n) return m;
    relinked++;
    return pre + (id.includes('%') ? encodeURI(n) : n);
  });
  return { text, changes, warnings, relinked };
}

// ---------- table des matières ----------
const escLabel = (s) => s.replace(/[\\`*_[\]<>&|~]/g, '\\$&');
const escSymbol = (s) => s.replace(/[\\`*_{}[\]<>()#+\-.!|~&]/g, '\\$&');
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function tocLine(n, t, html, extra_ = 0) {
  const L = t.levels[n.level];
  const sym = L.symbol ? `${html ? escHtml(L.symbol) : escSymbol(L.symbol)} ` : '';
  const href = encodeURI(n.slug);
  const link = html ? `<a href="#${href}">${escHtml(n.text)}</a>` : `[${escLabel(n.text)}](#${href})`;
  let s = sym + link;
  if (L.bold) s = `<b>${s}</b>`;
  if (L.italic) s = `<i>${s}</i>`;
  if (L.size) s = `<span style="font-size:${L.size}em">${s}</span>`;
  const extra = extra_ ? `<span class="fo">${'&ensp;'.repeat(extra_)}</span>` : '';
  return extra + '&ensp;'.repeat(L.indent) + s;
}

function renderToc(heads, t) {
  const [min, max] = t.range;
  // Arbre sur les seuls titres retenus : le parent est le titre retenu précédent de niveau inférieur,
  // donc si les niveaux au-dessus de la plage sont exclus, tous leurs enfants se suivent à plat.
  const roots = [];
  const stack = [];
  for (const h of heads) {
    if (h.level < min || h.level > max) continue;
    const node = { ...h, children: [] };
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
    stack.push(node);
  }

  const open = t.open ? ' open' : '';
  const anyFold = t.collapsible || Object.values(t.levels).some((l) => l.collapsible);
  // Avec du repli, tout est en HTML pur et SANS ligne vide : une ligne vide fait ressortir chaque entrée en paragraphe
  // (grands espaces) et, après un <details>, le Markdown ne serait plus interprété.
  const emitHtml = (nodes) => {
    const parts = [];
    for (const n of nodes) {
      if (t.levels[n.level].collapsible && n.children.length) {
        parts.push({ block: true, s: `<details${open}><summary>${tocLine(n, t, true)}</summary>\n${joinParts(emitHtml(n.children))}\n</details>` });
      } else {
        parts.push({ block: false, s: tocLine(n, t, true, t.foldOffset) });
        parts.push(...emitHtml(n.children));
      }
    }
    return parts;
  };
  const joinParts = (parts) => parts.map((p, i) => (!p.block && parts[i + 1] && !parts[i + 1].block ? `${p.s}<br>` : p.s)).join('\n');
  if (anyFold) {
    let body = joinParts(emitHtml(roots));
    if (t.collapsible && body) body = `<details${open}><summary>${escHtml(t.summary)}</summary>\n${body}\n</details>`;
    return { body, count: heads.filter((h) => h.level >= min && h.level <= max).length };
  }
  const emit = (nodes, out) => {
    for (const n of nodes) {
      if (t.levels[n.level].collapsible && n.children.length) {
        flush(out);
        const inner = { blocks: [], cur: [] };
        emit(n.children, inner);
        flush(inner);
        out.blocks.push(`<details${open}>\n<summary>${tocLine(n, t, true)}</summary>\n\n${inner.blocks.join('\n\n')}\n\n</details>`);
      } else {
        out.cur.push(tocLine(n, t, false));
        emit(n.children, out);
      }
    }
  };
  const flush = (out) => {
    if (out.cur.length) out.blocks.push(out.cur.join('<br>\n'));
    out.cur = [];
  };

  const out = { blocks: [], cur: [] };
  emit(roots, out);
  flush(out);
  let body = out.blocks.join('\n\n');
  if (t.collapsible && body) body = `<details${open}>\n<summary>${escHtml(t.summary)}</summary>\n\n${body}\n\n</details>`;
  return { body, count: heads.filter((h) => h.level >= min && h.level <= max).length };
}

const START = /^<!--\s*TOC\s*-->$/i;
const END = /^<!--\s*\/TOC\s*-->$/i;

export function applyToc(src, cfg) {
  const { eol, lines, heads, inFence } = scan(src);
  const { body, count } = renderToc(heads, cfg.toc);
  const block = ['<!-- TOC -->', '', ...body.split('\n'), '', '<!-- /TOC -->'];

  const find = (re, from = 0) => { for (let i = from; i < lines.length; i++) if (re.test(lines[i].trim()) && !inFence(i)) return i; return -1; };
  const a = find(START);
  const b = a >= 0 ? find(END, a + 1) : find(END);
  // Les sauts de page ajoutés à la main dans l'ancienne table sont conservés, devant l'entrée qui les suivait.
  const keep = new Map();
  if (a >= 0 && b > a) {
    for (let i = a + 1; i < b; i++) {
      if (!/^(\\(newpage|pagebreak|clearpage)|<!--\s*(newpage|pagebreak)\s*-->)$/i.test(lines[i].trim())) continue;
      const next = lines.slice(i + 1, b).find((l) => /href="#[^"]+"|\]\(#[^)]+\)/.test(l));
      const slug = next?.match(/href="#([^"]+)"|\]\(#([^)]+)\)/);
      if (slug) keep.set(slug[1] || slug[2], lines[i].trim());
    }
  }
  if (keep.size) {
    for (let i = 0; i < block.length; i++) {
      const m = block[i].match(/href="#([^"]+)"|\]\(#([^)]+)\)/);
      const key = m && (m[1] || m[2]);
      if (key && keep.has(key)) { block.splice(i, 0, keep.get(key)); keep.delete(key); i++; }
    }
  }
  let out;
  let inserted = false;
  if (a >= 0 && b > a) {
    out = [...lines.slice(0, a), ...block, ...lines.slice(b + 1)];
  } else if (a >= 0 || b >= 0) {
    throw new Error('repères de la table des matières incomplets : il faut <!-- TOC --> puis <!-- /TOC -->, dans cet ordre');
  } else {
    // Première fois : tout en haut, après les éventuelles commandes d'impression / commentaires de tête (<!-- nohf -->…).
    let i = 0;
    while (i < lines.length && (/^\s*$/.test(lines[i]) || /^<!--.*-->$/.test(lines[i].trim()) || /^\\(newpage|pagebreak|clearpage|nohf)$/i.test(lines[i].trim()))) i++;
    out = [...lines.slice(0, i), ...(i > 0 && lines[i - 1].trim() ? [''] : []), ...block, '', ...lines.slice(i)];
    inserted = true;
  }
  const text = out.join(eol);
  return { text, count, inserted, changed: text !== src };
}
