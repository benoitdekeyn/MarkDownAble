// Crée un nouveau document : doc/<nom>.md (si absent) + doc/<nom>.jsonc (configuration commentée).
//   npm run init -- MonDoc [options]
// Les options ne servent qu'à préremplir le .jsonc ; tout reste modifiable ensuite (voir --help).
import fs from 'node:fs';
import path from 'node:path';
import { stripJsonComments } from './jsonc.mjs';
import { DOC_DIR, SCRIPTS_DIR, CONFIG_SUFFIX, rel } from './workspace.mjs';
import { log } from './log.mjs';

const HELP = `Usage : npm run init -- <nom> [options]

Crée ${rel(DOC_DIR)}/<nom>.md (s'il n'existe pas) et ${rel(DOC_DIR)}/<nom>${CONFIG_SUFFIX} (configuration commentée ; dossier réglé dans paths.jsonc).

Options (toutes facultatives) :
  --title "Texte"        titre de l'onglet et du sommaire (défaut : nom du fichier)
  --icon media/logo.png  favicon + logo du sommaire (image de doc/)
  --language fr          langue de la page
  --theme auto|light|dark         thème de la page HTML (défaut auto)
  --embed-images         images incorporées au HTML au lieu d'être copiées dans output_html/
  --html-name index      nom du fichier HTML, sans extension (défaut index)
  --pdf-name nom         nom du fichier PDF, sans extension (défaut : le nom du document)
  --pdf-theme light|dark thème du PDF (défaut light)
  --format A4            A3, A4, A5, Letter, Legal, Tabloid
  --landscape            PDF en paysage
  --zoom 100             zoom du PDF en % (10 à 200)
  --margin 20mm          marge du PDF (les 4 côtés)  ·  ou --margins "20mm 18mm"  (haut/bas gauche/droite)
  --page-breaks 1,2      niveaux de titres qui commencent une nouvelle page du PDF ("none" = aucun)
  --hide-toc             retire la table des matières du PDF
  --no-header            pas d'en-tête de page PDF (défaut : titre + {h2})
  --no-footer            pas de pied de page PDF (défaut : {page} / {pages})
  --numbering off|decimal  schéma de numérotation des titres (off par défaut ; decimal : « ## 1. », « ### 1.1. »…)
  --toc-range 2,3        niveaux listés dans la table des matières (défaut 2,3)
  --no-md                ne crée pas le .md (configuration seule)
  --force                écrase un .jsonc existant (le .md n'est jamais écrasé)
  --help                 cette aide`;

const BOOLEAN = new Set(['embed-images', 'landscape', 'hide-toc', 'no-header', 'no-footer', 'no-md', 'force', 'help']);
const VALUE = new Set(['title', 'icon', 'language', 'theme', 'html-name', 'pdf-name', 'pdf-theme', 'format', 'zoom', 'margin', 'margins', 'page-breaks', 'numbering', 'toc-range']);

const die = (m) => { log.error(m); process.exit(1); };

const opts = {};
const positional = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) { positional.push(a); continue; }
  const [k, inline] = a.slice(2).split(/=(.*)/s);
  if (BOOLEAN.has(k)) {
    if (inline !== undefined) die(`--${k} n'accepte pas de valeur`);
    opts[k] = true;
  }
  else if (VALUE.has(k)) {
    const v = inline ?? argv[++i];
    if (v === undefined || (inline === undefined && String(v).startsWith('--'))) die(`--${k} attend une valeur`);
    opts[k] = v;
  } else die(`option inconnue : --${k} (voir --help)`);
}
if (opts.help) { console.log(HELP); process.exit(0); }
if (positional.length !== 1) die(`indiquez le nom du document : npm run init -- MonDoc\n\n${HELP}`);

const name = positional[0].replace(/\.(md|jsonc)$/i, '');
if (!name || /[\\/:*?"<>|]/.test(name) || name.startsWith('.') || /[. ]$/.test(name)
  || /[\u0000-\u001f]/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
  die(`nom de document invalide : "${positional[0]}" (sans dossier ni caractères interdits sous Windows)`);
}

const oneOf = (key, allowed, def) => {
  const v = opts[key] ?? def;
  if (!allowed.some((x) => x.toLowerCase() === String(v).toLowerCase())) die(`--${key} doit valoir ${allowed.join(', ')} (reçu "${v}")`);
  return allowed.find((x) => x.toLowerCase() === String(v).toLowerCase());
};
const stem = (key, ext) => {
  if (opts[key] === undefined) return null;
  const v = String(opts[key]).replace(new RegExp(`\\${ext}$`, 'i'), '');
  if (!v || /[\\/:*?"<>|]/.test(v) || /[. ]$/.test(v) || /^\.|[\u0000-\u001f]/.test(v)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(v)) die(`--${key} : nom de fichier invalide "${opts[key]}"`);
  return v;
};
const levels = (key, def, { allowNone = false, sort = true } = {}) => {
  const raw = String(opts[key] ?? def).trim();
  if (allowNone && raw.toLowerCase() === 'none') return [];
  const list = raw.split(/[,\s]+/).filter(Boolean).map(Number);
  if (!list.length || list.some((n) => !Number.isInteger(n) || n < 1 || n > 6)) die(`--${key} : niveaux de 1 à 6 séparés par des virgules (ex. 1,2)`);
  const unique = [...new Set(list)];
  return sort ? unique.sort() : unique;
};

const theme = oneOf('theme', ['auto', 'light', 'dark'], 'auto');
const pdfTheme = oneOf('pdf-theme', ['light', 'dark'], 'light');
const format = oneOf('format', ['A3', 'A4', 'A5', 'Letter', 'Legal', 'Tabloid'], 'A4');
const numbering = oneOf('numbering', ['off', 'decimal'], 'off');
const zoom = Number(opts.zoom ?? 100);
if (!(zoom >= 10 && zoom <= 200)) die('--zoom doit être compris entre 10 et 200');
const tocRange = levels('toc-range', '2,3', { sort: false });
if (tocRange.length !== 2 || tocRange[0] > tocRange[1]) die('--toc-range : deux niveaux [min,max] dans l’ordre croissant, ex. 2,3');

let margins = { top: '20mm', right: '18mm', bottom: '20mm', left: '18mm' };
const marginValue = /^\d+(\.\d+)?(mm|cm|in|pt|px)$/;
if (opts.margin) {
  if (!marginValue.test(opts.margin)) die('--margin : valeur avec unité, ex. 20mm');
  margins = { top: opts.margin, right: opts.margin, bottom: opts.margin, left: opts.margin };
} else if (opts.margins) {
  const p = String(opts.margins).trim().split(/\s+/);
  if (![1, 2, 4].includes(p.length) || !p.every((x) => marginValue.test(x))) die('--margins : 1, 2 (haut/bas gauche/droite) ou 4 (haut droite bas gauche) valeurs avec unité');
  const [t, r = t, b = t, l = r] = p.length === 2 ? [p[0], p[1], p[0], p[1]] : p;
  margins = { top: t, right: r, bottom: b, left: l };
}

const levelsJson = numbering === 'decimal'
  ? `{
      "1": { "style": "ignore" },
      "2": { "style": "decimal", "separator": "." },
      "3": { "style": "decimal", "separator": ".", "cumulative": true },
      "4": { "style": "ignore" },
      "5": { "style": "ignore" },
      "6": { "style": "ignore" }
    }`
  : `{
      "1": { "style": "ignore" },
      "2": { "style": "ignore" },
      "3": { "style": "ignore" },
      "4": { "style": "ignore" },
      "5": { "style": "ignore" },
      "6": { "style": "ignore" }
    }`;

const values = {
  name,
  htmlName: stem('html-name', '.html') ?? 'index',
  title: opts.title ?? null,
  icon: opts.icon ?? null,
  language: opts.language ?? 'fr',
  theme,
  embedImages: !!opts['embed-images'],
  tocRange,
  pdfName: stem('pdf-name', '.pdf'),
  pdfTheme,
  format,
  landscape: !!opts.landscape,
  zoom,
  margins,
  pageBreaks: levels('page-breaks', '1,2', { allowNone: true }),
  hideToc: !!opts['hide-toc'],
  header: opts['no-header'] ? null : { left: '{title}', right: '{h2}' },
  footer: opts['no-footer'] ? null : { center: '{page} / {pages}' },
};
const inline = (v) => JSON.stringify(v).replace(/^\{/, '{ ').replace(/\}$/, ' }').replace(/":(?! )/g, '": ').replace(/,"/g, ', "');

const template = fs.readFileSync(path.join(SCRIPTS_DIR, 'init.template.jsonc'), 'utf8');
const text = template.replace(/@@(\w+)@@/g, (_, k) => {
  if (k === 'numberingLevels') return levelsJson;
  if (k === 'name') return name;
  if (!(k in values)) die(`jeton inconnu dans init.template.jsonc : ${k}`);
  const v = values[k];
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? inline(v) : Array.isArray(v) ? JSON.stringify(v).replace(/,/g, ', ') : JSON.stringify(v);
}).replace(/\r?\n/g, '\n');

try { JSON.parse(stripJsonComments(text)); } catch (e) { die(`configuration générée invalide (bug de l'outil) : ${e.message}`); }

fs.mkdirSync(DOC_DIR, { recursive: true });
const configPath = path.join(DOC_DIR, `${name}${CONFIG_SUFFIX}`);
const mdPath = path.join(DOC_DIR, `${name}.md`);
if (fs.existsSync(configPath) && !opts.force) die(`${rel(configPath)} existe déjà (--force pour l'écraser)`);
fs.writeFileSync(configPath, text);
log.success(`${rel(configPath)} créé`);

if (opts['no-md']) {
  if (!fs.existsSync(mdPath)) log.info(`${rel(mdPath)} absent : crée-le pour générer ce document`);
} else if (fs.existsSync(mdPath)) log.info(`${rel(mdPath)} existe déjà : conservé`);
else {
  fs.writeFileSync(mdPath, `# ${opts.title ?? name}\n\nVotre texte ici.\n\n## Première section\n\nDu **Markdown**, des formules $E = mc^2$, du code et des diagrammes Mermaid.\n`);
  log.success(`${rel(mdPath)} créé`);
}
log.muted(`\nEnsuite : npm run dev -- ${name}  |  npm run build:html -- ${name}  |  npm run build:pdf -- ${name}`);
