// Organisation de l'espace de travail et découverte des documents.
//   doc/       les sources : <nom>.md + <nom>.jsonc (+ images)
//   template/  le visuel des générations (CSS / JS), modifiable
//   output_html/ <nom>/ : page HTML générée + copie des seuls médias utilisés
//   output_pdf/ PDF générés
//   scripts/   les outils (ce dossier), state/ : mémoire de numérotation
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripJsonComments, isObj } from './jsonc.mjs';

export const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE = path.dirname(SCRIPTS_DIR);
export const DOC_DIR = path.join(WORKSPACE, 'doc');
export const HTML_OUTPUT_DIR = path.join(WORKSPACE, 'output_html');
export const PDF_OUTPUT_DIR = path.join(WORKSPACE, 'output_pdf');
export const TEMPLATE_DIR = path.join(WORKSPACE, 'template');
export const STATE_DIR = path.join(SCRIPTS_DIR, 'state');
export const CONFIG_SUFFIX = '.jsonc';

export class ConfigError extends Error {}

export const rel = (p) => path.relative(WORKSPACE, p).split(path.sep).join('/');

// Un document = un <nom>.jsonc valide (JSON avec commentaires) ET le <nom>.md correspondant dans doc/.
// Les .md sans config sont ignorés ; une config invalide est signalée (problems) sans bloquer les autres.
// `names` restreint aux documents demandés (insensible à la casse, extension facultative).
export function discoverDocs(names = []) {
  if (!fs.existsSync(DOC_DIR)) throw new ConfigError(`dossier doc/ introuvable (${DOC_DIR})`);
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
    if (!fs.existsSync(mdPath)) { problems.push({ name, message: `${name}.md introuvable dans doc/` }); continue; }
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
