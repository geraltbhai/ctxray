'use strict';
/**
 * Minimal, dependency-free .gitignore matcher.
 *
 * Implements the parts of the gitignore spec that actually appear in real
 * repositories: comments, blank lines, negation (!), directory-only patterns
 * (trailing /), anchoring (a leading or embedded /), and the *, ?, ** globs.
 * Character classes ([abc]) are passed through to the regex engine.
 *
 * Not implemented: backslash escapes of # and !, and the rule that a negation
 * cannot re-include a file whose parent directory is excluded (we apply
 * negations literally, which is the behaviour people expect).
 */

/** Escape a literal string for use inside a RegExp. */
function esc(s) {
  return s.replace(/[.+^${}()|\\]/g, '\\$&');
}

/**
 * Compile one gitignore line into a matcher, or null if the line is inert.
 * @param {string} line
 */
function compile(line, base = '') {
  let pattern = line;

  // Strip trailing unescaped whitespace.
  pattern = pattern.replace(/\s+$/, '');
  if (!pattern || pattern.startsWith('#')) return null;

  let negate = false;
  if (pattern.startsWith('!')) {
    negate = true;
    pattern = pattern.slice(1);
  }

  let dirOnly = false;
  if (pattern.endsWith('/')) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }
  if (!pattern) return null;

  // A pattern is anchored if it contains a slash anywhere but the very end.
  const anchored = pattern.includes('/');
  if (pattern.startsWith('/')) pattern = pattern.slice(1);

  // Build the regex body.
  let body = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // '**'
        const before = i === 0 ? '' : pattern[i - 1];
        const after = pattern[i + 2];
        i++;
        if (after === '/') {
          body += '(?:.*/)?';
          i++; // consume the slash
        } else if (before === '/' || i === 1) {
          body += '.*';
        } else {
          body += '.*';
        }
      } else {
        body += '[^/]*';
      }
    } else if (c === '?') {
      body += '[^/]';
    } else if (c === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) {
        body += '\\[';
      } else {
        let cls = pattern.slice(i + 1, close);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        body += `[${cls}]`;
        i = close;
      }
    } else if (c === '/') {
      body += '/';
    } else {
      body += esc(c);
    }
  }

  // Patterns from a nested .gitignore are relative to that file's directory.
  const root = base ? `^${esc(base)}/` : '^';
  const prefix = anchored ? root : `${root}(?:.*/)?`;
  // A directory pattern also matches everything beneath it.
  const suffix = '(?:/.*)?$';
  const re = new RegExp(prefix + body + suffix);

  return { re, negate, dirOnly, source: line };
}

class Ignore {
  constructor() {
    this.rules = [];
  }

  /**
   * Add gitignore-formatted text. `base` is the POSIX-style directory the
   * patterns are relative to (''  for repo root).
   */
  add(text, base = '') {
    const lines = String(text).split(/\r?\n/);
    for (const line of lines) {
      const rule = compile(line, base);
      if (rule) this.rules.push(rule);
    }
    return this;
  }

  /** Add raw patterns (array of strings), no base. */
  addPatterns(patterns) {
    for (const p of patterns) {
      const rule = compile(p);
      if (rule) this.rules.push(rule);
    }
    return this;
  }

  /**
   * @param {string} relPath POSIX-style path relative to the scan root
   * @param {boolean} isDir
   * @returns {boolean} true if the path is ignored
   */
  ignores(relPath, isDir = false) {
    let ignored = false;
    for (let i = 0; i < this.rules.length; i++) {
      const r = this.rules[i];
      if (r.dirOnly && !isDir) {
        // A dir-only rule can still exclude files beneath the directory; that
        // is handled by the walker skipping the directory itself.
        continue;
      }
      if (r.re.test(relPath)) ignored = !r.negate;
    }
    return ignored;
  }
}

module.exports = { Ignore, compile };
