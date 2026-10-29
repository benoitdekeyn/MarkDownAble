// Organisation de l'espace de travail et découverte des documents.
//   doc/       les sources : <nom>.md + <nom>.jsonc (+ images)
//   template/  le visuel des générations (CSS / JS), modifiable
//   output_html/ <nom>/ : page HTML générée + copie des seuls médias utilisés
//   output_pdf/ PDF générés
//   scripts/   les outils (ce dossier), state/ : mémoire de numérotation
// Les emplacements de doc/, output_html/ et output_pdf/ se règlent dans paths.jsonc (à la racine) ; sans ce fichier,
// ce sont les dossiers du même nom à la racine du dépôt.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripJsonComments, isObj } from './jsonc.mjs';
import { log } from './log.mjs';

export const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE = path.dirname(SCRIPTS_DIR);
export const TEMPLATE_DIR = path.join(WORKSPACE, 'template');
export const STATE_DIR = path.join(SCRIPTS_DIR, 'state');
export const PATHS_FILE = path.join(WORKSPACE, 'paths.jsonc');
export const CONFIG_SUFFIX = '.jsonc';

export class ConfigError extends Error {}

export const rel = (p) => {
  const r = path.relative(WORKSPACE, p);
  const outside = r === '..' || r.startsWith(`..${path.sep}`) || path.isAbsolute(r);
  return (outside ? p : r).split(path.sep).join('/');
};

const DEFAULT_PATHS = { doc: './doc', output_html: './output_html', output_pdf: './output_pdf' };
const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
// vrai si `child` est `parent` ou se trouve dedans
const isInside = (child, parent) => {
  const r = path.relative(norm(parent), norm(child));
  return r === '' || (r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r));
};

// Lit paths.jsonc (JSON avec commentaires autorisés), résout les chemins relatifs depuis la racine du dépôt et
// vérifie qu'ils sont utilisables. Lève une ConfigError explicite sinon.
function readPaths() {
  let user = {};
  if (fs.existsSync(PATHS_FILE)) {
    try { user = JSON.parse(stripJsonComments(fs.readFileSync(PATHS_FILE, 'utf8'))); }
    catch (e) { throw new ConfigError(`paths.jsonc : JSON invalide : ${e.message}`); }
    if (!isObj(user)) throw new ConfigError('paths.jsonc doit contenir un objet JSON { "doc": …, "output_html": …, "output_pdf": … }');
  }
  const unknown = Object.keys(user).filter((k) => !(k in DEFAULT_PATHS));
  if (unknown.length) throw new ConfigError(`paths.jsonc : clé(s) inconnue(s) : ${unknown.join(', ')} (valides : ${Object.keys(DEFAULT_PATHS).join(', ')})`);
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULT_PATHS)) {
    const value = key in user ? user[key] : fallback;
    if (typeof value !== 'string' || !value.trim()) throw new ConfigError(`paths.jsonc : "${key}" doit être un chemin (texte non vide), relatif au dossier de l'outil ou absolu`);
    out[key] = path.resolve(WORKSPACE, value.trim());
  }
  const reserved = [SCRIPTS_DIR, TEMPLATE_DIR, path.join(WORKSPACE, 'node_modules'), path.join(WORKSPACE, '.git')];
  const entries = Object.entries(out);
  for (const [key, dir] of entries) {
    if (isInside(WORKSPACE, dir)) throw new ConfigError(`paths.jsonc : "${key}" (${dir}) ne peut pas être le dossier de l'outil ni l'un de ses parents`);
    const clash = reserved.find((r) => isInside(dir, r));
    if (clash) throw new ConfigError(`paths.jsonc : "${key}" (${dir}) ne peut pas être dans ${rel(clash)}/ (dossier interne de l'outil)`);
    if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) throw new ConfigError(`paths.jsonc : "${key}" (${dir}) existe mais n'est pas un dossier`);
  }
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [ka, a] = entries[i];
      const [kb, b] = entries[j];
      if (isInside(a, b) || isInside(b, a)) throw new ConfigError(`paths.jsonc : "${ka}" et "${kb}" doivent être trois dossiers distincts, aucun ne peut contenir un autre (${a} / ${b})`);
    }
  }
  return out;
}

// Liaisons « vivantes » : reloadPaths() les met à jour pour tous les modules qui les importent.
export let DOC_DIR;
export let HTML_OUTPUT_DIR;
export let PDF_OUTPUT_DIR;
export function reloadPaths() {
  const p = readPaths();
  DOC_DIR = p.doc;
  HTML_OUTPUT_DIR = p.output_html;
  PDF_OUTPUT_DIR = p.output_pdf;
}
try { reloadPaths(); }
catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  log.error(e.message);
  process.exit(1);
}

// Un document = un <nom>.jsonc valide (JSON avec commentaires) ET le <nom>.md correspondant dans le dossier des documents.
// Les .md sans config sont ignorés ; une config invalide est signalée (problems) sans bloquer les autres.
// `names` restreint aux documents demandés (insensible à la casse, extension facultative).
export function discoverDocs(names = []) {
  if (!fs.existsSync(DOC_DIR)) throw new ConfigError(`dossier des documents introuvable : ${DOC_DIR} (réglé par "doc" dans paths.jsonc)`);
  const files = fs.readdirSync(DOC_DIR);
  const docs = [];
  const problems = [];
  const configured = new Set();
  for (const f of files.sort()) {
    if (f.startsWith('.') || !f.toLowerCase().endsWith(CONFIG_SUFFIX)) continue;
    const name = f.slice(0, -CONFIG_SUFFIX.length);
    if (!name) continue;
    configured.add(name.toLowerCase());
    const configPath = path.join(DOC_DIR, f);
    const mdPath = path.join(DOC_DIR, `${name}.md`);
    let user;
    try { user = JSON.parse(stripJsonComments(fs.readFileSync(configPath, 'utf8'))); }
    catch (e) { problems.push({ name, message: `JSON invalide : ${e.message}` }); continue; }
    if (!isObj(user)) { problems.push({ name, message: 'doit contenir un objet JSON { … }' }); continue; }
    if (!fs.existsSync(mdPath)) { problems.push({ name, message: `${name}.md introuvable dans ${rel(DOC_DIR)}/` }); continue; }
    docs.push({ name, mdPath, configPath, user });
  }
  const ignored = files.filter((f) => /\.md$/i.test(f) && !f.startsWith('.') && !configured.has(f.slice(0, -3).toLowerCase()));

  if (!names.length) return { docs, problems, ignored };
  const wanted = names.map((n) => n.replace(/(\.jsonc|\.md)$/i, '').toLowerCase());
  const unknown = wanted.filter((w) => !configured.has(w));
  if (unknown.length) {
    const hint = ignored.some((f) => unknown.includes(f.slice(0, -3).toLowerCase())) ? ` (ce .md n'a pas de ${unknown[0]}${CONFIG_SUFFIX})` : '';
    throw new ConfigError(`document inconnu : ${names.filter((_, i) => unknown.includes(wanted[i])).join(', ')}${hint}. Documents disponibles : ${[...configured].join(', ') || 'aucun'}`);
  }
  return {
    docs: docs.filter((d) => wanted.includes(d.name.toLowerCase())),
    problems: problems.filter((p) => wanted.includes(p.name.toLowerCase())),
    ignored: [],
  };
}
