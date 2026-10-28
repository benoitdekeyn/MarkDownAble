// Commandes d'édition du Markdown source (doc/<nom>.md), pilotées par doc/<nom>.jsonc :
//   node scripts/edit.mjs numbering [nom]   -> (re)numérote les titres                       (npm run edit:numbering)
//   node scripts/edit.mjs guess [nom]       -> détecte la numérotation présente dans le .md  (npm run edit:numbering:guess)
//   node scripts/edit.mjs reset [nom]       -> retire toute la numérotation                  (npm run edit:numbering:reset)
//   node scripts/edit.mjs toc [nom]         -> (re)génère la table des matières              (npm run edit:toc)
//   Plusieurs commandes se chaînent dans l'ordre : node scripts/edit.mjs numbering toc (npm run edit:outline)
// Le nom du document n'est obligatoire que s'il y en a plusieurs dans doc/.
// Option : --dry (n'écrit rien, affiche ce qui serait fait)
import fs from 'node:fs';
import path from 'node:path';
import { replaceObjectAt } from './jsonc.mjs';
import { resolveOutlineConfig, applyNumbering, applyToc, guessNumbering, normalizeLevels, noNumbering } from './outline.mjs';
import { STATE_DIR, ConfigError, discoverDocs, rel } from './workspace.mjs';
import { log } from './log.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const COMMANDS = ['numbering', 'guess', 'reset', 'toc'];
const unknownOptions = args.filter((a) => a.startsWith('--') && a !== '--dry');
if (unknownOptions.length) {
  log.error(`option(s) inconnue(s) : ${unknownOptions.join(', ')}`);
  process.exit(1);
}
const positional = args.filter((a) => !a.startsWith('--'));
const cmds = positional.filter((a) => COMMANDS.includes(a));
const names = positional.filter((a) => !COMMANDS.includes(a));

const die = (m) => { log.error(m); process.exit(1); };
if (!cmds.length || names.length > 1) die(`usage : node scripts/edit.mjs ${COMMANDS.join(' | ')} [nom du document] [--dry]`);

let doc;
try {
  const found = discoverDocs(names);
  found.problems.forEach((p) => log.error(`${p.name} : ${p.message}`));
  if (found.docs.length > 1) die(`plusieurs documents (${found.docs.map((d) => d.name).join(', ')}) : précisez lequel, ex. node scripts/edit.mjs ${cmds[0]} ${found.docs[0].name}`);
  doc = found.docs[0];
  if (!doc) die('aucun document valide (il faut doc/<nom>.md et doc/<nom>.jsonc)');
} catch (e) { if (e instanceof ConfigError) die(e.message); throw e; }
const CONFIG_FILE = doc.configPath;
const rawConfig = fs.readFileSync(CONFIG_FILE, 'utf8');
const source = doc.mdPath;
let cfg;
try { cfg = resolveOutlineConfig(doc.user); } catch (e) { die(e.message); }

// Dernière numérotation appliquée ou détectée pour ce .md : sert à retirer proprement l'ancienne numérotation
// quand on change de schéma. Sans fichier d'état (ou s'il concerne un autre .md), on la devine depuis le document.
const stateFile = path.join(STATE_DIR, `${doc.name}.numbering.json`);
const srcKey = path.basename(source);
const readState = () => {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (s.source !== srcKey || !s.levels) return null;
    // Avant la version 2, « none » signifiait « niveau laissé tel quel » (aujourd'hui « ignore »).
    if (s.version !== 2) for (const o of Object.values(s.levels)) if (o.style === 'none') o.style = 'ignore';
    return normalizeLevels(s.levels);
  } catch { return null; }
};
const writeState = (levels) => {
  if (!DRY) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify({ version: 2, source: srcKey, levels }, null, 2)}\n`);
  }
};

let text = fs.readFileSync(source, 'utf8');
const original = text;
let configText = rawConfig;
let state = readState();
const previous = () => {
  if (state) return { levels: state, from: 'dernière numérotation appliquée' };
  return { levels: guessNumbering(text).levels, from: 'détection dans le document' };
};

const levelLine = (n, o) => `${n}: ${o.style.padEnd(7)} séparateur ${JSON.stringify(o.separator)}${['none', 'ignore'].includes(o.style) ? '' : o.cumulative ? ', cumulatif' : ', non cumulatif'}`;

function report(r) {
  r.warnings.forEach((w) => log.warning(w));
  r.changes.slice(0, 20).forEach((c) => log.muted(`  l.${c.line} : ${c.from}  →  ${c.to}`));
  if (r.changes.length > 20) log.muted(`  … et ${r.changes.length - 20} autre(s)`);
}

const levelsBlock = (levels) => {
  const rows = [1, 2, 3, 4, 5, 6].map((n) => {
    const o = levels[n];
    return `      "${n}": { "style": ${JSON.stringify(o.style)}, "separator": ${JSON.stringify(o.separator)}, "cumulative": ${o.cumulative} }`;
  });
  return `{\n${rows.join(',\n')}\n    }`;
};

try {
  for (const cmd of cmds) {
    if (cmd === 'numbering') {
      const prev = previous();
      const r = applyNumbering(text, cfg.numbering.levels, prev.levels);
      report(r);
      log.success(r.changes.length
        ? `numérotation : ${r.changes.length} titre(s) modifié(s), ${r.relinked || 0} lien(s) interne(s) mis à jour (ancien schéma : ${prev.from})`
        : 'numérotation : déjà à jour');
      text = r.text;
      state = normalizeLevels(cfg.numbering.levels);
      writeState(state);
    } else if (cmd === 'reset') {
      const prev = previous();
      const r = applyNumbering(text, noNumbering(), prev.levels);
      report(r);
      log.success(r.changes.length
        ? `numérotation retirée de ${r.changes.length} titre(s), ${r.relinked || 0} lien(s) interne(s) mis à jour (schéma retiré : ${prev.from})`
        : 'aucune numérotation à retirer');
      text = r.text;
      state = noNumbering();
      writeState(state);
      log.muted("  (le .jsonc n'est pas modifié ; edit:numbering réappliquera son schéma)");
    } else if (cmd === 'guess') {
      const { levels, detail } = guessNumbering(text);
      log.info('Numérotation détectée :');
      for (const n of [1, 2, 3, 4, 5, 6]) {
        const d = detail[n];
        log.muted(`  niveau ${levelLine(n, levels[n])}   (${d.numbered}/${d.total} titres numérotés)`);
      }
      configText = replaceObjectAt(configText, ['numbering', 'levels'], levelsBlock(levels));
      if (!DRY) {
        fs.writeFileSync(CONFIG_FILE, configText);
        log.success(`${path.basename(CONFIG_FILE)} : numbering.levels mis à jour`);
      }
      state = normalizeLevels(levels);
      writeState(state);
    } else {
      const r = applyToc(text, cfg);
      log.success(`table des matières : ${r.count} entrée(s)${r.inserted ? ', insérée en haut du document' : ''}${r.changed ? '' : ', déjà à jour'}`);
      text = r.text;
    }
  }
} catch (e) { die(e.message); }

if (DRY) log.info('--dry : aucun fichier modifié');
else if (text !== original) {
  fs.writeFileSync(source, text);
  log.success(`${rel(source)} mis à jour`);
}
