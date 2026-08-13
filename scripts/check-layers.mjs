/**
 * check-layers.mjs — verifica que las capas del servidor se respeten.
 *
 * Reglas (ver docs/arquitectura):
 *
 *  1. Los helpers de `apps/web/src/server/modules/<nombre>/internal/*` solo
 *     pueden importarse desde DENTRO de su propio modulo (el `index.ts` publico
 *     del modulo y sus tests). Un route, otro modulo o `infra` no deben mirar
 *     el interior de un modulo ajeno: van por su `index.ts`.
 *
 *  2. `infra/*` es una capa de soporte: no puede depender de los modulos de
 *     negocio. Si un modulo necesita algo de infra lo usa directo (es legal),
 *     pero infra nunca importa modulos.
 *
 * Uso: `npm run check:layers` (desde la raiz del repo).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = process.cwd();
const toPosix = (p) => p.split(sep).join('/');
const rel = (p) => toPosix(relative(ROOT, p));

const MODULES_RE = /^apps\/web\/src\/server\/modules\/([^/]+)\/internal\//;
const INFRA_DIR = 'apps/web/src/server/infra';
const MODULES_DIR = 'apps/web/src/server/modules';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'coverage', '.turbo',
  'public', 'backend/public',
]);

/** @returns {string[]} archivos fuente bajo `dir` (recursivo, ordenado). */
function collectFiles(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, acc);
    } else if (/\.(ts|tsx|mjs|cjs|js|jsx)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

const IMPORT_RE = /(?:from\s*)(['"])([^'"]+)\1/g;
const SIDE_EFFECT_RE = /^\s*import\s*(?:type\s+)?(['"])([^'"]+)\1/gm;

/** Devuelve { fileRel, line, targetRel, specifier } o null si el especificador es irrelevante. */
function resolveTarget(file, specifier, line) {
  const fileRel = rel(file);
  let targetRel = null;

  if (specifier.startsWith('@/')) {
    targetRel = 'apps/web/' + specifier.slice(2);
  } else if (specifier.startsWith('.')) {
    targetRel = rel(resolve(dirnameSafe(file), specifier));
  } else {
    return null; // bare (node, workspace, npm)
  }

  targetRel = toPosix(targetRel).replace(/\.(ts|tsx|mjs|cjs|js|jsx)$/, '');
  return { fileRel, line, targetRel, specifier };
}

function dirnameSafe(file) {
  const i = file.lastIndexOf(sep);
  return i === -1 ? file : file.slice(0, i);
}

const violations = [];

function checkFile(file) {
  const src = readFileSync(file, 'utf8');
  const fileRel = rel(file);

  const record = (regex) => {
    for (const match of src.matchAll(regex)) {
      const specifier = match[2];
      const line = src.slice(0, match.index).split('\n').length;
      const info = resolveTarget(file, specifier, line);
      if (!info) continue;

      // Regla 1: internal solo desde el propio modulo.
      const m = info.targetRel.match(MODULES_RE);
      if (m) {
        const owner = m[1];
        const ownerDir = `${MODULES_DIR}/${owner}`;
        if (!fileRel.startsWith(ownerDir)) {
          violations.push({
            file: info.fileRel, line: info.line,
            message: `importa ${info.specifier} (internal de "${owner}") desde fuera del modulo — usa apps/web/src/server/modules/${owner}`,
          });
        }
      }

      // Regla 2: infra no depende de modulos de negocio.
      if (fileRel.startsWith(INFRA_DIR) && info.targetRel.startsWith(MODULES_DIR)) {
        violations.push({
          file: info.fileRel, line: info.line,
          message: `infra importa un modulo de negocio (${info.specifier}) — infra no depende de modulos`,
        });
      }
    }
  };

  record(IMPORT_RE);
  record(SIDE_EFFECT_RE);
}

const files = collectFiles(ROOT).sort();
for (const file of files) checkFile(file);

if (violations.length > 0) {
  console.error(`check:layers — ${violations.length} violacion(es) de capas:\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.message}`);
  }
  console.error('\nArregla los imports o mueve el codigo a la capa correcta y vuelve a correr.');
  process.exit(1);
}

console.log(`check:layers — OK (${files.length} archivos revisados, sin violaciones)`);
