// Publication : npm run release
//   1. copie README.md (racine) vers doc/README.md (écrase) ;
//   2. génère les HTML puis les PDF de tous les documents de doc/ ;
//   3. copie output_html/README/index.html vers README.html et output_pdf/README.pdf vers README.pdf (à la racine, écrase).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WORKSPACE, DOC_DIR, HTML_OUTPUT_DIR, PDF_OUTPUT_DIR, SCRIPTS_DIR, CONFIG_SUFFIX, rel } from './workspace.mjs';
import { log } from './log.mjs';

const die = (message) => { log.error(message); process.exit(1); };

const readme = path.join(WORKSPACE, 'README.md');
const docReadme = path.join(DOC_DIR, 'README.md');
const docConfig = path.join(DOC_DIR, `README${CONFIG_SUFFIX}`);

if (!fs.existsSync(readme)) die('README.md introuvable à la racine du dépôt');
if (!fs.existsSync(docConfig)) die(`${rel(docConfig)} introuvable : sans lui, doc/README.md ne serait pas généré (créez-le avec « npm run init -- README --no-md »)`);

fs.copyFileSync(readme, docReadme);
log.info(`README.md → ${rel(docReadme)}`);

// Les builds tournent dans leur propre processus (loader, couleurs et bilan restent identiques à un build manuel).
for (const args of [[], ['--pdf']]) {
  const run = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, 'build.mjs'), ...args, '--no-open'], { stdio: 'inherit', cwd: WORKSPACE });
  if (run.status !== 0) die(`génération ${args.length ? 'PDF' : 'HTML'} en échec : release interrompue, rien n'a été copié à la racine`);
}

const copies = [
  [path.join(HTML_OUTPUT_DIR, 'README', 'index.html'), path.join(WORKSPACE, 'README.html')],
  [path.join(PDF_OUTPUT_DIR, 'README.pdf'), path.join(WORKSPACE, 'README.pdf')],
];
for (const [from] of copies) {
  if (!fs.existsSync(from)) die(`${rel(from)} introuvable : vérifiez "htmlName" (index) et "pdf.name" (README) dans ${rel(docConfig)}`);
}
for (const [from, to] of copies) fs.copyFileSync(from, to);
log.success(`Release terminée : ${copies.map(([, to]) => rel(to)).join(' et ')} mis à jour`);
