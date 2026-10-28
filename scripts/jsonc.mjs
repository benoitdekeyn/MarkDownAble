// Utilitaires partagés : lecture d'un JSON avec commentaires (<nom>.jsonc) et fusion de configurations.
export function stripJsonComments(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i];
      else if (c === '"') inStr = false;
    } else if (c === '"') { inStr = true; out += c; }
    else if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; }
    else if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; }
    else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1'); // virgules finales tolérées
}

export const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Position [début, fin] (inclus, accolades comprises) de l'objet associé à la clé `key`, cherché dans text[from, to).
// Ignore les chaînes et les commentaires ; renvoie null si la clé n'est pas suivie d'un objet.
export function findObjectRange(text, key, from = 0, to = text.length) {
  const skip = (i) => { // saute espaces et commentaires
    for (;;) {
      while (i < to && /\s/.test(text[i])) i++;
      if (text[i] === '/' && text[i + 1] === '/') { while (i < to && text[i] !== '\n') i++; }
      else if (text[i] === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2) + 2; if (i < 2) return to; }
      else return i;
    }
  };
  const endOfString = (i) => { for (i++; i < to && text[i] !== '"'; i++) if (text[i] === '\\') i++; return i; };
  for (let i = from; i < to; i++) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { while (i < to && text[i] !== '\n') i++; }
    else if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2) + 1; if (i < 1) return null; }
    else if (c === '"') {
      const e = endOfString(i);
      if (text.slice(i + 1, e) === key) {
        let j = skip(e + 1);
        if (text[j] === ':') {
          j = skip(j + 1);
          if (text[j] === '{') {
            let depth = 0;
            for (let k = j; k < to; k++) {
              if (text[k] === '"') k = endOfString(k);
              else if (text[k] === '/' && text[k + 1] === '/') { while (k < to && text[k] !== '\n') k++; }
              else if (text[k] === '/' && text[k + 1] === '*') { k = text.indexOf('*/', k + 2) + 1; }
              else if (text[k] === '{') depth++;
              else if (text[k] === '}' && --depth === 0) return [j, k];
            }
            return null;
          }
        }
      }
      i = e;
    }
  }
  return null;
}

// Remplace l'objet situé à `keys` (ex. ['numbering', 'levels']) par `objectText`, ou le crée s'il manque.
export function replaceObjectAt(text, keys, objectText) {
  let from = 0;
  let to = text.length;
  let range = null;
  for (const [i, k] of keys.entries()) {
    const r = findObjectRange(text, k, from, to);
    if (!r) {
      if (i === 0) { // section absente : on l'ajoute en tête de l'objet racine
        const open = text.indexOf('{');
        const inner = keys.slice(1).reduceRight((acc, key) => `{ ${JSON.stringify(key)}: ${acc} }`, objectText);
        return `${text.slice(0, open + 1)}\n  ${JSON.stringify(k)}: ${inner},${text.slice(open + 1)}`;
      }
      const parentOpen = range[0];
      return `${text.slice(0, parentOpen + 1)}\n    ${JSON.stringify(k)}: ${objectText},${text.slice(parentOpen + 1)}`;
    }
    range = r;
    [from, to] = [r[0] + 1, r[1]];
  }
  return text.slice(0, range[0]) + objectText + text.slice(range[1] + 1);
}

export function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}
