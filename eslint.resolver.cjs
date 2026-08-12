'use strict';

/**
 * Module resolver for eslint-plugin-boundaries.
 *
 * Why this exists: under NodeNext ESM every relative import carries a `.js`
 * extension that maps to a `.ts` source file. `eslint-import-resolver-node`
 * cannot make that mapping, so every internal import resolves to "unknown" —
 * and an unresolved import is not merely a missing warning, it means
 * `boundaries/element-types` never classifies the dependency and the layer
 * rules **silently stop firing**. That is the exact failure the Phase 0 gate
 * exists to catch, so resolution is load-bearing.
 *
 * Written rather than installed (ER-049): this project has no tsconfig path
 * aliases and no directory imports, so the whole problem is three candidate
 * filenames. Two independent safety nets make a bug here loud rather than
 * silent: `boundaries/no-unknown` is an error, so anything this fails to
 * resolve breaks the lint run; and `pnpm verify:boundaries` asserts that each
 * planted violation still produces its expected error.
 *
 * CommonJS on purpose — eslint-module-utils loads resolvers with `require()`.
 */

const fs = require('node:fs');
const path = require('node:path');

/** @param {string} source */
function candidatesFor(source) {
  const candidates = [];
  if (source.endsWith('.js')) candidates.push(`${source.slice(0, -'.js'.length)}.ts`);
  candidates.push(`${source}.ts`, source);
  return candidates;
}

module.exports = {
  interfaceVersion: 2,

  /**
   * @param {string} source  the import specifier
   * @param {string} file    absolute path of the importing file
   * @returns {{ found: boolean, path?: string }}
   */
  resolve(source, file) {
    // Bare specifiers are packages. boundaries classifies unresolved bare
    // specifiers as external, which is what `boundaries/external` acts on.
    if (!source.startsWith('.')) return { found: false };

    const fromDirectory = path.dirname(file);
    for (const candidate of candidatesFor(source)) {
      const resolved = path.resolve(fromDirectory, candidate);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        return { found: true, path: resolved };
      }
    }
    return { found: false };
  },
};
