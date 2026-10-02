'use strict';
/**
 * File classification: language detection and context-waste detection.
 *
 * The core opinion of ctxray is that not all tokens are equal. A 40k-token
 * lockfile and a 40k-token service layer both cost the same money, but only one
 * of them ever helps a coding agent answer a question. `classify()` decides
 * which bucket a file falls into and, when it is waste, says why in language a
 * human can act on.
 */

const path = require('path');

// ---------------------------------------------------------------------------
// Language map
// ---------------------------------------------------------------------------
const LANGS = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.py': 'Python', '.pyi': 'Python', '.rb': 'Ruby', '.go': 'Go', '.rs': 'Rust',
  '.java': 'Java', '.kt': 'Kotlin', '.kts': 'Kotlin', '.scala': 'Scala',
  '.c': 'C', '.h': 'C', '.cc': 'C++', '.cpp': 'C++', '.cxx': 'C++', '.hpp': 'C++', '.hh': 'C++',
  '.cs': 'C#', '.swift': 'Swift', '.m': 'Objective-C', '.mm': 'Objective-C',
  '.php': 'PHP', '.pl': 'Perl', '.lua': 'Lua', '.r': 'R', '.jl': 'Julia',
  '.ex': 'Elixir', '.exs': 'Elixir', '.erl': 'Erlang', '.hs': 'Haskell',
  '.clj': 'Clojure', '.dart': 'Dart', '.zig': 'Zig', '.nim': 'Nim', '.v': 'V',
  '.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell', '.fish': 'Shell', '.ps1': 'PowerShell',
  '.sql': 'SQL', '.graphql': 'GraphQL', '.gql': 'GraphQL', '.proto': 'Protobuf',
  '.html': 'HTML', '.htm': 'HTML', '.vue': 'Vue', '.svelte': 'Svelte', '.astro': 'Astro',
  '.css': 'CSS', '.scss': 'SCSS', '.sass': 'SCSS', '.less': 'Less', '.styl': 'Stylus',
  '.json': 'JSON', '.jsonc': 'JSON', '.json5': 'JSON',
  '.yml': 'YAML', '.yaml': 'YAML', '.toml': 'TOML', '.ini': 'INI', '.cfg': 'INI',
  '.xml': 'XML', '.svg': 'SVG', '.md': 'Markdown', '.mdx': 'Markdown',
  '.rst': 'reStructuredText', '.txt': 'Text', '.csv': 'CSV', '.tsv': 'CSV',
  '.tf': 'Terraform', '.hcl': 'HCL', '.dockerfile': 'Docker', '.nix': 'Nix',
  '.ipynb': 'Notebook', '.tex': 'LaTeX', '.gradle': 'Gradle', '.cmake': 'CMake',
};

const NAMED = {
  'dockerfile': 'Docker', 'makefile': 'Make', 'rakefile': 'Ruby', 'gemfile': 'Ruby',
  'procfile': 'Config', 'justfile': 'Just', 'cmakelists.txt': 'CMake',
};

// Extensions we should never try to read as text.
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.tiff', '.heic',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.mov', '.avi', '.mkv', '.flac', '.m4a',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.tar', '.zst',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.so', '.dylib', '.dll', '.exe', '.bin', '.o', '.a', '.class', '.jar', '.wasm',
  '.pyc', '.pyo', '.pdb', '.db', '.sqlite', '.sqlite3', '.parquet', '.avro',
  '.pkl', '.pickle', '.npy', '.npz', '.h5', '.hdf5', '.onnx', '.pt', '.pth',
  '.safetensors', '.ckpt', '.gguf', '.bin', '.model', '.mo',
  '.psd', '.ai', '.sketch', '.fig', '.blend', '.dmg', '.iso', '.apk', '.ipa',
]);

// ---------------------------------------------------------------------------
// Waste categories, most specific first. Each rule returns a reason string.
// `severity` drives ordering and the "reclaimable" calculation:
//   'always'  - an agent essentially never needs this. 100% reclaimable.
//   'usually' - rarely needed; safe default to exclude. 90% reclaimable.
//   'review'  - often excludable but depends on the project. 50% reclaimable.
// ---------------------------------------------------------------------------

const LOCKFILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock',
  'composer.lock', 'gemfile.lock', 'poetry.lock', 'pdm.lock', 'uv.lock',
  'cargo.lock', 'go.sum', 'pipfile.lock', 'packages.lock.json', 'mix.lock',
  'flake.lock', 'pubspec.lock', 'deno.lock', 'gradle.lockfile',
]);

// Deliberately conservative. Every name here must be a directory that is
// essentially never hand-written source, because a false positive tells someone
// to hide their own code from their agent — the worst thing this tool could do.
//
// Names considered and REJECTED, with the reason:
//   packages/  pnpm and Lerna monorepos keep first-party source here
//   bin/       Node CLIs, Go cmd wrappers and shell scripts live here
//   env/       too generic; a module named env is plausible
//   lib/       compiled output for some projects, hand-written source for more
//   release/   debug/   generic English words; the real cases sit under
//                       target/ or build/, which are already covered
const VENDOR_DIRS = [
  'node_modules', 'bower_components', 'vendor', 'third_party', 'thirdparty',
  '.venv', 'venv', 'virtualenv', 'site-packages', '.tox', '.nox',
  'pods', '.pub-cache', '.cargo', '.gradle', '.m2', 'jspm_packages',
];

const BUILD_DIRS = [
  'dist', 'build', 'out', 'target', 'obj',
  '.next', '.nuxt', '.svelte-kit', '.output', '.vercel', '.netlify', '.turbo',
  '.parcel-cache', '.cache', '.vite', 'coverage', 'htmlcov', '.nyc_output',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.terraform',
  'storybook-static', '.docusaurus', '_site', 'staticfiles', '.serverless',
];

const TEST_FIXTURE_DIRS = [
  '__snapshots__', 'snapshots', 'fixtures', '__fixtures__', 'testdata',
  'cassettes', '__mocks__', 'golden', 'goldens', '.snapshots',
];

// `.d.ts` is NOT here on purpose: type declarations are dense, high-value
// context for an agent even when a build step produced them.
const GENERATED_HINTS = [
  '.generated.', '.gen.', '_pb2.', '_pb.', '.pb.', '-lock.', '.min.',
  '.bundle.', '.chunk.', '.designer.', '.g.dart', '.freezed.', '_generated.',
];

const DOC_ARCHIVE_DIRS = ['changelog', 'changelogs', '.changeset', 'licenses', 'locale', 'locales', 'i18n', 'translations'];

function dirSegments(rel) {
  return rel.split('/').slice(0, -1).map((s) => s.toLowerCase());
}

/**
 * @param {string} rel POSIX path relative to the scan root
 * @param {number} bytes
 * @param {string|null} sample first few KB of the file, or null for binaries
 * @returns {{language: string, waste: null | {category: string, reason: string, severity: string}}}
 */
function classify(rel, bytes, sample) {
  const base = path.posix.basename(rel);
  const lower = base.toLowerCase();
  const ext = path.posix.extname(lower);
  const segs = dirSegments(rel);

  const language =
    NAMED[lower] ||
    (lower.startsWith('dockerfile') ? 'Docker' : null) ||
    LANGS[ext] ||
    (ext ? ext.slice(1).toUpperCase() : 'Other');

  const waste = detectWaste({ rel, base, lower, ext, segs, bytes, sample });
  return { language, waste };
}

function detectWaste(f) {
  const { rel, lower, ext, segs, bytes, sample } = f;

  // Directory-level rules come first, deliberately. A .pyc inside __pycache__
  // is both "binary" and "build output" — "build output" is the more useful
  // thing to tell someone, because it names a whole directory they can drop.

  // --- version control / editor metadata ----------------------------------
  if (segs.includes('.git') || segs.includes('.svn') || segs.includes('.hg')) {
    return w('vcs', 'Version-control internals', 'always');
  }

  // --- vendored dependencies ----------------------------------------------
  for (const d of VENDOR_DIRS) {
    if (segs.includes(d)) {
      return w('vendor', `Vendored dependency under ${d}/ — not your code`, 'always');
    }
  }

  // --- build output --------------------------------------------------------
  for (const d of BUILD_DIRS) {
    if (segs.includes(d)) {
      return w('build', `Build artifact under ${d}/ — regenerated from source`, 'always');
    }
  }

  // --- binaries: an agent cannot read them at all -------------------------
  if (BINARY_EXT.has(ext)) {
    return w('binary', 'Binary file — unreadable by a language model', 'always');
  }

  // --- lockfiles -----------------------------------------------------------
  if (LOCKFILES.has(lower)) {
    return w('lockfile', 'Dependency lockfile — huge, and the manifest says the same thing', 'always');
  }

  // --- minified / bundled --------------------------------------------------
  if (/\.min\.(js|css|mjs)$/.test(lower) || /\.(bundle|chunk)\.[a-f0-9]{6,}\./.test(lower)) {
    return w('minified', 'Minified bundle — maximum tokens, minimum meaning', 'always');
  }
  if (sample && isMinified(sample)) {
    return w('minified', 'Minified or single-line generated file', 'always');
  }

  // --- generated code ------------------------------------------------------
  if (sample && /^(\/\/|#|--|\/\*|<!--)?\s*(Code generated by|@generated|AUTOGENERATED|AUTO-GENERATED|DO NOT EDIT|This file is auto-generated)/im.test(sample.slice(0, 600))) {
    return w('generated', 'Declares itself auto-generated — regenerate, do not read', 'always');
  }
  for (const h of GENERATED_HINTS) {
    if (lower.includes(h) && h !== '.min.' && h !== '-lock.') {
      return w('generated', `Generated code (matched "${h}")`, 'usually');
    }
  }

  // --- test snapshots and fixtures ----------------------------------------
  for (const d of TEST_FIXTURE_DIRS) {
    if (segs.includes(d)) {
      return w('fixtures', `Test fixture/snapshot under ${d}/ — high volume, low signal`, 'usually');
    }
  }
  if (/\.snap$/.test(lower)) {
    return w('fixtures', 'Jest snapshot', 'always');
  }

  // --- bulk data -----------------------------------------------------------
  if (['.csv', '.tsv', '.ndjson', '.jsonl'].includes(ext) && bytes > 64 * 1024) {
    return w('data', `Bulk data file (${kb(bytes)}) — send a schema and 3 sample rows instead`, 'usually');
  }
  if (ext === '.json' && bytes > 256 * 1024) {
    return w('data', `Very large JSON (${kb(bytes)}) — likely data, not configuration`, 'usually');
  }
  if (ext === '.sql' && bytes > 256 * 1024) {
    return w('data', `Large SQL dump (${kb(bytes)})`, 'usually');
  }
  if (ext === '.ipynb') {
    return w('notebook', 'Notebook — carries base64 outputs and execution metadata', 'review');
  }

  // --- big SVG / map files -------------------------------------------------
  if (ext === '.svg' && bytes > 32 * 1024) {
    return w('asset', `Large SVG (${kb(bytes)}) — path data, no semantics`, 'always');
  }
  if (/\.(map|log)$/.test(lower)) {
    return w('build', 'Source map or log file', 'always');
  }

  // --- documentation archives ---------------------------------------------
  if (/^changelog(\.md|\.txt|\.rst)?$/i.test(f.lower) && bytes > 24 * 1024) {
    return w('docs', `Long changelog (${kb(bytes)}) — history an agent rarely needs`, 'review');
  }
  for (const d of DOC_ARCHIVE_DIRS) {
    if (segs.includes(d) && bytes > 8 * 1024) {
      return w('docs', `Archive/localisation content under ${d}/`, 'review');
    }
  }

  // --- oversized single files ---------------------------------------------
  if (bytes > 512 * 1024) {
    return w('oversized', `${kb(bytes)} in a single file — will not fit a focused context window`, 'review');
  }

  return null;
}

function w(category, reason, severity) {
  return { category, reason, severity };
}

function kb(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** Heuristic: very long average line length means minified or generated. */
function isMinified(sample) {
  const lines = sample.split('\n');
  if (lines.length < 2) return sample.length > 2000;
  let long = 0;
  for (const l of lines) if (l.length > 500) long++;
  return long / lines.length > 0.3 && sample.length > 2000;
}

const RECLAIM = { always: 1.0, usually: 0.9, review: 0.5 };

const CATEGORY_LABEL = {
  binary: 'Binary files',
  vcs: 'VCS internals',
  vendor: 'Vendored dependencies',
  build: 'Build output',
  lockfile: 'Lockfiles',
  minified: 'Minified bundles',
  generated: 'Generated code',
  fixtures: 'Test fixtures & snapshots',
  data: 'Bulk data',
  notebook: 'Notebooks',
  asset: 'Large assets',
  docs: 'Doc archives',
  oversized: 'Oversized files',
  duplicate: 'Duplicate content',
};

module.exports = { classify, BINARY_EXT, RECLAIM, CATEGORY_LABEL, LANGS, kb };
