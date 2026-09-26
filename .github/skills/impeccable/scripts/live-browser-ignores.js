// Modified by vaultdex/workflow-kit (scripts/impeccable/maintainability.patch):
// split into helpers to bound cognitive complexity; behavior is unchanged.
/**
 * Browser-side resolution of project detector waivers for Impeccable live mode.
 *
 * The live server serializes `.impeccable/config.json` + `config.local.json`
 * detector ignores (plus the served-root prefixes from the inject config's
 * `files` globs) into `window.__IMPECCABLE_PROJECT_IGNORES__`. This part
 * resolves that config against the current page's URL path when a detect scan
 * starts, so the overlay suppresses the same findings the CLI and the edit
 * hook do (issue #639).
 *
 * Mirrors filterDetectionFindings in cli/lib/impeccable-config.mjs:
 *   1. `ignoreRules` suppress a rule project-wide.
 *   2. `ignoreValues` entries with `value: "*"` suppress their rule in the
 *      files their globs name. The CLI never applies an unscoped wildcard
 *      (isIgnoredFindingValue returns false for it), so neither does this.
 *   3. Remaining `ignoreValues` entries match on the finding's own value;
 *      those are forwarded as `disabledValues` for the detector bundle to
 *      apply where the findings are assembled.
 *   4. `ignoreFiles` globs that name the page waive it wholesale: the
 *      resolver reports `skipScan: true` and the detector answers the scan
 *      with zero findings, mirroring shouldIgnoreDetectionFile in the CLI
 *      and the edit hook's own ignoreFiles gate.
 *
 * `pageFiles`, when the server could resolve it, lists the real project
 * files the inject config serves. A URL that suffix-matches exactly one of
 * them takes that file as its only project identity; an ambiguous or absent
 * match falls back to the served-root common ancestor below.
 *
 * Known gap, unchanged from PR #645: framework apps inject into source files
 * (src/routes/about/+page.svelte) while scans see route URLs (/about), so
 * entries scoped to source or asset paths never match a page candidate and
 * are dropped. That shows the finding, which is the conservative direction.
 *
 * Kept separate from live-browser.js so the glob and page-scope logic can be
 * unit tested in Node (tests/live-browser-ignores.test.mjs) without the full
 * overlay UI bundle.
 */
(function (root) {
  'use strict';
  if (!root) return;

  // Hand-edited config may hold anything; every list read degrades to empty.
  const asArray = (value) => (Array.isArray(value) ? value : []);

  // Keep in step with normalizeIgnoreRule / normalizeIgnoreValue in
  // cli/lib/impeccable-config.mjs.
  function normalizeIgnoreRule(rule) {
    return String(rule || '').trim().toLowerCase();
  }

  function normalizeIgnoreValue(value) {
    return String(value || '')
      .trim()
      .replace(/^["']|["']$/g, '')
      .replaceAll('+', ' ')
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  // One glob token starting at `i`: its RegExp source and the next index.
  function globToken(glob, i) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] !== '*') return ['[^/]*', i + 1];
      // `**` also consumes a following slash.
      return ['.*', glob[i + 2] === '/' ? i + 3 : i + 2];
    }
    if (c === '?') return ['[^/]', i + 1];
    if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) return [String.raw`\{`, i + 1];
      const parts = glob.slice(i + 1, end).split(',').map((p) => p.replace(/[.+^$()|[\]\\]/g, String.raw`\$&`));
      return [`(?:${parts.join('|')})`, end + 1];
    }
    return [/[.+^$()|[\]\\]/.test(c) ? `\\${c}` : c, i + 1];
  }

  // Glob -> RegExp. Supports `**`, `*`, `?`, and `{a,b}` alternation.
  // Keep in step with globToRegex in cli/lib/impeccable-config.mjs.
  function globToRegex(glob) {
    let re = '^';
    let i = 0;
    while (i < glob.length) {
      const [source, next] = globToken(glob, i);
      re += source;
      i = next;
    }
    re += '$';
    return new RegExp(re);
  }

  // The project-relative paths this page could be known as. Ignore globs are
  // project-relative (prototype/foo.html) and the URL is site-relative
  // (/foo.html), because a static server's root usually sits inside the
  // project; `roots` carries that prefix. The server reads it from the inject
  // config's own `files` globs, which already state where the served pages
  // are. Do not derive it from the ignore globs: a single entry scoped to
  // prototype/library/** would then lend prototype/library/ as a candidate
  // prefix to every page, and that rule would suppress site-wide.
  //
  // Each prefixed path also contributes its slash suffixes, mirroring
  // findingMatchesScopedIgnoreFile in cli/lib/impeccable-config.mjs (which
  // matches globs against every path suffix of the finding's file).
  //
  // One live session is served by one server, so a single document root must
  // sit at or above every configured page. The only prefix that can safely
  // be asserted is therefore the deepest common ancestor of the glob roots.
  // Treating each glob's own prefix as an identity goes wrong in both
  // directions: disjoint roots (src/ and public/) invent simultaneous
  // identities for one URL, so a waiver scoped to src/foo.html hides a
  // finding on a page served from public/foo.html; nested roots (prototype/
  // and prototype/library/, from globs at two depths in one tree) are not
  // alternatives at all, and demanding a waiver match under both stops
  // prototype/index.html from applying anywhere. When the globs share no
  // common root, no prefix is asserted and only the URL path itself matches.
  function pageCandidates(pathname, roots, pageFiles) {
    const pagePath = pagePathOf(pathname);
    const candidates = new Set();
    const addSuffixes = (fullPath) => {
      const parts = fullPath.split('/').filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        candidates.add(parts.slice(i).join('/'));
      }
    };
    addSuffixes(pagePath);

    // The served page list names the real files the inject config serves.
    // A URL that suffix-matches exactly one of them has an unambiguous
    // project identity; assert that identity and stop guessing from roots
    // (PR #645 review: with src/ and public/ both served, /foo.html must not
    // borrow src/foo.html's waivers while actually serving public/foo.html).
    // Zero matches or several fall through to the common-ancestor fallback:
    // ambiguity resolves toward showing the finding.
    const knownPages = asArray(pageFiles).filter((entry) => typeof entry === 'string' && entry
      && (entry === pagePath || entry.endsWith('/' + pagePath)));
    if (knownPages.length === 1) {
      addSuffixes(knownPages[0]);
      return [...candidates];
    }

    const common = commonRoot(roots);
    if (common.length > 0) addSuffixes(common.join('/') + '/' + pagePath);
    return [...candidates];
  }

  // The URL path as the project-relative file name the ignore globs use.
  function pagePathOf(pathname) {
    let pagePath = String(pathname || '');
    try {
      pagePath = decodeURIComponent(pagePath);
    } catch {
      // Malformed percent-escape: match on the raw path rather than throwing.
    }
    pagePath = pagePath.replace(/^\/+/, '');
    // A directory URL serves that directory's index, and the ignore globs
    // name files. Without this, /news/ never matches prototype/news/index.html.
    if (pagePath === '' || pagePath.endsWith('/')) pagePath += 'index.html';
    return pagePath;
  }

  // Deepest common ancestor of the served roots, as path segments.
  function commonRoot(roots) {
    const prefixes = asArray(roots)
      .filter((entry) => typeof entry === 'string')
      .map((entry) => entry.split('/').filter(Boolean));
    let common = prefixes.length > 0 ? prefixes[0] : [];
    for (const segments of prefixes.slice(1)) {
      let i = 0;
      while (i < common.length && i < segments.length && common[i] === segments[i]) i += 1;
      common = common.slice(0, i);
    }
    return common;
  }

  function matchesScope(globs, candidates) {
    return globs.some((glob) => {
      let re;
      try {
        re = globToRegex(String(glob));
      } catch {
        // Malformed glob: skip it, as matchesAnyGlob does in the CLI.
        return false;
      }
      return candidates.some((candidate) => re.test(candidate));
    });
  }

  /**
   * Resolve the serialized project ignores for one page.
   *
   * @param {object} options
   * @param {object} options.ignores  window.__IMPECCABLE_PROJECT_IGNORES__,
   *   in whatever state it arrived: absent, null, or hand-edited into the
   *   wrong shape. Every read tolerates that and degrades to no filtering.
   * @param {string} options.pathname  location.pathname of the scanned page.
   * @returns {{ disabledRules: string[], disabledValues: Array<{rule: string, value: string}>, skipScan: boolean }}
   */
  function resolveDetectIgnores({ ignores, pathname } = {}) {
    const config = ignores && typeof ignores === 'object' ? ignores : {};
    const candidates = pageCandidates(pathname, config.roots, config.pageFiles);

    // detector.ignoreFiles waives whole files. When any glob names this
    // page, the scan itself is skipped; rule and value lists are returned
    // empty because nothing will run.
    const ignoreFileGlobs = asArray(config.ignoreFiles)
      .filter((glob) => typeof glob === 'string' && glob.trim());
    if (ignoreFileGlobs.length > 0 && matchesScope(ignoreFileGlobs, candidates)) {
      return { disabledRules: [], disabledValues: [], skipScan: true };
    }

    const disabledRules = new Set(
      asArray(config.ignoreRules)
        .filter((rule) => typeof rule === 'string')
        .map(normalizeIgnoreRule)
        .filter(Boolean),
    );
    const disabledValues = [];

    for (const entry of asArray(config.ignoreValues)) {
      applyIgnoreValue(entry, candidates, disabledRules, disabledValues);
    }

    return { disabledRules: [...disabledRules], disabledValues, skipScan: false };
  }

  // One detector.ignoreValues entry, applied to this page's candidates.
  function applyIgnoreValue(entry, candidates, disabledRules, disabledValues) {
    if (!entry || typeof entry !== 'object') return;
    const rule = normalizeIgnoreRule(entry.rule);
    const value = normalizeIgnoreValue(entry.value);
    if (!rule || !value) return;
    const files = [
      ...(typeof entry.file === 'string' && entry.file.trim() ? [entry.file.trim()] : []),
      ...asArray(entry.files).filter((glob) => typeof glob === 'string' && glob.trim()),
    ];
    if (value === '*') {
      // Wildcards suppress their rule only inside the files they name.
      if (files.length > 0 && matchesScope(files, candidates)) disabledRules.add(rule);
      return;
    }
    if (files.length > 0 && !matchesScope(files, candidates)) return;
    disabledValues.push({ rule, value });
  }

  root.__IMPECCABLE_LIVE_IGNORES__ = {
    version: 1,
    resolveDetectIgnores,
  };
})(typeof window !== 'undefined' ? window : globalThis);
