// npm run ghost : ajoute le dossier de l'outil au .gitignore du projet qui le contient.
// Cas d'usage : l'outil est cloné dans un sous-dossier (ex. markdownable/) de VOTRE dépôt ; ce dossier garde son propre
// .git (pour « git pull » les mises à jour) mais n'est plus suivi par le dépôt parent.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WORKSPACE } from './workspace.mjs';
import { log } from './log.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const parent = path.dirname(WORKSPACE);
let root;
try { root = path.resolve(git(parent, 'rev-parse', '--show-toplevel')); }
catch {
  log.error(`${parent} n'est pas dans un dépôt Git : rien à ignorer. Faites d'abord « git init » dans ce dossier parent.`);
  process.exit(1);
}

const entry = `${path.relative(root, WORKSPACE).split(path.sep).join('/')}/`;
const gitignore = path.join(root, '.gitignore');
const current = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
const lines = current.split(/\r?\n/).map((l) => l.trim());

if (lines.includes(entry) || lines.includes(`/${entry}`) || lines.includes(entry.slice(0, -1))) {
  log.info(`${entry} est déjà dans ${gitignore}`);
} else {
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const prefix = current && !current.endsWith('\n') ? eol : '';
  fs.appendFileSync(gitignore, `${prefix}${entry}${eol}`);
  log.success(`${entry} ajouté à ${gitignore}`);
}

let tracked = '';
try { tracked = git(root, 'ls-files', '--', entry); } catch {}
if (tracked) log.warning(`des fichiers de ${entry} sont déjà suivis par le dépôt parent : « git rm -r --cached ${entry.slice(0, -1)} » pour les retirer de l'index.`);
