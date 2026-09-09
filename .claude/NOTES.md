# react — Design Decisions & Session Notes

This file exists so that Claude sessions working in this repo don't re-litigate settled
decisions or re-discover the same issues from scratch. It is local to this repo (not tied to
any one machine's global Claude memory), so it travels with the code.

**Maintenance rule:** when a standing decision changes, update the section below in place
(don't just append a contradiction lower down). When a new investigation/session produces a
decision, finding, or reverted approach worth remembering, add a dated entry under Session Log.
Keep entries terse — this is a reference, not a transcript.

## Standing design decisions & constraints

- **Vulnerability/review threat model: externally-exploitable only.** This library is a power
  tool for developers building their own services, not a hardened black box. When reviewing for
  "vulnerabilities," only count issues reachable from a downstream, untrusted HTTP/WebSocket
  client hitting a service built on the framework (anonymous or low-privilege caller). Do NOT
  flag: developer-only footguns (misusing an API, a decorator applied wrong in your own code),
  internal utilities only the operator touches (build/CLI/startup wiring), or purely theoretical
  races with no concrete external trigger path. Every finding should be able to name the actual
  HTTP route/method or WS message type that reaches the code in question.

- **Commit discipline.** Don't `git commit` unless explicitly asked for *that specific piece of
  work*. An autonomous-execution/"commit as you go" approval given for one approved plan (e.g. via
  plan mode) is scoped to that plan only — it does not carry forward to later, separate requests in
  the same session, even ones that look similar in kind (a follow-up review-and-fix pass, a
  refactor, a new feature), and even after a full review-and-fix cycle with passing tests. Default
  to leaving changes staged/unstaged and saying so; only commit automatically within the exact
  scope of a plan that was explicitly approved as autonomous. If unsure whether new work falls
  inside that scope, treat it as outside and ask.

- **Commit message style: a flat list of one-line, verb-led items — no summary/title line, no
  `-`/`*` bullet markers.** This isn't just a style preference — it's dictated by how `release`
  (`@rapidrest/cli`) actually builds `CHANGELOG.md`. `collectChangelogBullets`/
  `classifyChangelogLine` (that repo's `src/lib/release.ts`) parse `git log --pretty=format:%B` and
  treat **every non-blank line of a commit's full message as its own changelog bullet** — there is
  no subject/body distinction. A conventional "short imperative subject + blank line + prose body"
  commit therefore leaks one changelog bullet per body sentence, and a `-`/`*`-prefixed line breaks
  `classifyChangelogLine`'s verb detection (it reads the line's first whitespace-delimited word as
  the verb; a leading `-` defeats that lookup and the dash leaks into the changelog text as
  `"- - Added foo"`). Correct format:
  - No separate summary/title line — if a commit needs an overview, that overview is itself just
    one more flat line, not a heading distinct from the rest.
  - No bullet-marker prefix of any kind — write bare lines.
  - Lead each line with an imperative verb where it fits: `Add`/`Fix`/`Remove` (and `-ing` forms)
    are recognized and become `Added`/`Fixed`/`Removed` entries; `Configuring`/`Converting`/
    `Refactoring`/`Updating`/etc. become `Changed`. Anything else still works, defaulting to
    `Changed` verbatim — see `CHANGELOG_VERB_REWRITES` in that repo's `src/lib/release.ts` for the
    full map.
  - A blank line before a trailing git trailer (`Co-Authored-By:`, `Signed-off-by:`, etc.) is fine
    — trailers matching `CHANGELOG_NOISE_PATTERNS` are dropped from the changelog — but nothing
    else should follow the item list.
  This mirrors JP's standing convention across his other repos; copy this exact rule verbatim into
  each sibling repo's own NOTES.md rather than paraphrasing it, since the paraphrase is what caused
  this to be gotten wrong in the first place (see `@rapidrest/cli`'s own NOTES.md, 2026-09-07 entry,
  for the full incident writeup and the `CHANGELOG_NOISE_PATTERNS` fix that accompanied it).

- **Static export architecture: crawl the real server over real HTTP, never reimplement
  `ReactRoute`'s rendering.** `exportStaticSite()`/`runStaticExport()` (`src/static.ts`) boot the
  app's actual server (real DI, real config, real `@ReactService`s) and crawl it with `fetch()`,
  writing whatever HTML it actually returns. This is deliberate: the exported output can never
  diverge from what a live deployment serves. Route *discovery* (`appDirScan.ts`'s
  `scanAppDirPages()`/`fileToRouteTemplate()`) and *resolution* (`ReactRoute.resolveAppFile()`)
  used to be two independently-maintained conventions that could drift — closed in the 2026-09-09
  dynamic-routes session by moving the file<->route convention (bracket syntax included) into
  `appDirScan.ts` as the one canonical place it's defined; `resolveAppFile()`'s own filesystem walk
  still exists separately (it needs live suffix/dual-root probing that a precomputed route list
  doesn't fit — see that session's log entry), but the *naming convention* itself no longer has two
  sources of truth.

- **`appDir` convention: `"app"` default for a single app, `"apps/<name>"` for multi-app.**
  `ReactRoute`, `createViteConfig()`, and `exportStaticSite()` all default `appDir` to `"app"`.
  Multi-app projects (`createViteConfig({ appDir: [...] })`, `exportStaticSite({ apps: [...] })`)
  use explicit `"apps/<name>"` paths instead — never rely on the single-app default in a
  multi-app project. `ReactRoute`'s own default used to be `"apps/app"` (mismatched with
  `vite.ts`/`static.ts`'s `"app"`) — fixed to `"app"` for consistency; no shipped code relied on
  the old default since every real route class already overrides `appDir` explicitly.

- **Multi-app `routePrefix` gotcha: use `""`, not `"/"`, for the root-mounted app.** In the
  `apps: StaticExportApp[]` / multi-app `createViteConfig` form, `routePrefix` is concatenated
  directly onto a route path that already starts with `/`. `routePrefix: "/"` produces a
  double-slash (`"//page1"`) instead of the intended root mount — this bit the first draft of the
  multi-app test suite itself. Single-app's flat `routePrefix` option isn't affected the same way
  since it's never used as an *output* path prefix, only a fetch-URL prefix.

## Session Log

- **2026-08-22** — Major session: added static site export (`src/static.ts`:
  `discoverRoutes()`/`exportStaticSite()`/`runStaticExport()`, `rapidreact export` CLI command)
  and multi-app support (`createViteConfig({ appDir: string[] })`, `exportStaticSite({ apps })`),
  both fully tested (100% coverage) and taken through a full multi-agent code review with fixes
  applied. Also:
  - Fixed a silently-broken CI trigger (`build.yml`'s `on.push.branches: []` never fired —
    lint/test/build hadn't been running automatically on push at all).
  - `static.ts`'s `writeRouteHtml()` gained a path-containment check (refuses to write outside
    `outDir`). Initially reported as a "security" finding in a code review, but it doesn't meet
    the externally-exploitable bar above: the `route` value it checks only ever comes from
    `discoverRoutes()` (real filenames under the developer's own `appDir`) or `options.paths` (a
    value the developer writes directly into their own `src/export.ts`) — never from an HTTP/WS
    request. Decision: **kept anyway**, but recategorized — it's a fail-fast/DX guard against a
    self-inflicted typo (e.g. `paths: ["../admin"]`), not a vulnerability fix. When defending or
    reporting a finding like this in future reviews, say so explicitly up front (containment/DX
    guard vs. externally-exploitable) rather than reaching for security framing by default.
  - `exportStaticSite()` now empties `outDir` before writing (so a page removed from `app/` or
    newly `exclude`d doesn't leave stale/personalized HTML from a prior run), guarded against
    emptying cwd, an ancestor of cwd, or the filesystem root.
  - The `_404`/`404.html` probe now checks for an actual 404 response before writing it.
  - Confirmed dependencies are fully current against the live npm registry and in parity with
    `core`/`service-core`; `typescript` stays pinned `^6.0.3` (not `7.x`) because
    `@typescript-eslint/parser@8.67.0`'s own peerDependency still caps at `<6.1.0` — re-verify
    this constraint before ever bumping typescript past 6.x.
  - Wrote a real `CONTRIBUTING.md` (previously every "CONTRIBUTING"/`CONTRIBUTORS.*` file across
    the whole `rapidrest` org was actually the same credits list under inconsistent names — no
    repo had an actual contribution guide). Propagated to `react`/`cli`/`core`/`service-core`/
    `auth`/`auth-server` with per-repo-tailored bug-report/feature-request examples. Credits list
    standardized on `CONTRIBUTORS.md` (not `.txt`) per explicit direction.
  - Explored centralizing issue tracking via a GitHub Project; abandoned it (sync/reliability
    concerns, and GitHub's "Auto-add to project" workflow only supports one repo per rule with no
    multi-repo or bulk-link mechanism) — reverted to plain per-repo Issues tabs.
  - Migrated `auth-server`'s `vite.config.ts` off its hand-rolled `mergeConfig()`/`plugins[1]`
    workaround onto the new native `createViteConfig({ appDir: [...] })` array form — source-only
    change; `auth-server` depends on the *published* `@rapidrest/react@^0.11.0`, so this won't
    actually build until a version with array support is published and that dependency is bumped.
  - **1.0 status at end of session**: code considered ready (100% coverage, reviewed, validated
    against `auth-server` as a real consumer). Not yet done: version bump (`package.json` still
    `0.11.0`), `RELEASE_NOTES.md` still under `## Unreleased` (needs a dated `## v1.0.0` heading),
    and the actual tag/publish — all deliberately withheld pending explicit go-ahead. `cli`'s
    stale `@rapidrest/react` template pin (`^0.8.0`) and the `rapidrest.dev` docs site are
    deliberately deferred to a separate coordinated pass once every component library is locked
    — not oversights, don't "fix" them preemptively without checking first.
  - Read this file only partway through the session, not at the start — led to the mis-scoped
    security finding above. Always read `.claude/NOTES.md` before substantive work in this repo,
    not just when something goes wrong.

- **2026-09-06** — Fixed two real SSR bugs found via a downstream consumer (`mail-server`) actually
  running `yarn dev`/`yarn build` for the first time against a page importing a stylesheet from a
  shared component (this package's own documented pattern for getting CSS into a client entry's
  manifest — see the `appDir` decision above for the general docs-vs-reality drift risk this kind
  of gap represents).
  - **Bug 1 — a page/layout module's `import "*.css"` crashed SSR outright.** `ReactRoute.
    renderPage()` loads page/layout modules via a plain Node `import()` (`pathToFileURL(...).href`)
    — not through Vite, which is what actually understands CSS imports for the *client* bundle.
    Node's own loader has no format for `.css` and throws `ERR_UNKNOWN_FILE_EXTENSION` (dev, run
    from `.tsx` source where the file exists on disk) or `ERR_MODULE_NOT_FOUND` (production,
    `tsc`-compiled `dist/` never gets a copy of the `.css` file at all). Fixed via a Node Module
    Customization Hook (`module.register()`, called once at the top of `ReactRoute.tsx`) —
    `src/ssrAssetLoaderHooks.ts` intercepts *both* `resolve` (redirects matching extensions to a
    synthetic `css-stub:` URL that always resolves, regardless of whether a file exists on disk)
    and `load` (returns an empty module for that synthetic URL) — needed both hooks since the two
    failure modes above trip at different stages. The hooks file must be fully self-contained (it
    runs in Node's own separate loader thread, no shared state with the rest of this package) and
    its own specifier must be chosen based on `import.meta.url.endsWith(".tsx")` (source vs
    compiled) — `register()`'s specifier resolution is Node's own, and does NOT understand the
    TypeScript/NodeNext `.js`-refers-to-sibling-`.ts` convention every other import in this
    codebase relies on, so a hardcoded `.js` extension broke instantly under Vitest/any test
    runner importing the `.tsx` source directly.
  - **Bug 2 (found only once Bug 1 was fixed and a real `<link>` tag could be checked at all) —
    `resolveClientUrls()` only ever read the matched manifest entry's own `css` array, silently
    dropping any stylesheet imported by a *shared* component** (a layout/shell several pages
    import) rather than the entry file itself. Vite hoists CSS shared across multiple entries into
    whichever intermediate chunk actually contains the import — visible in the manifest via that
    chunk's own `imports`/`css` fields, never propagated up onto the entries that transitively
    import it. This means `AdminShell`/any shared shell component's CSS import (the sanctioned
    pattern per the Phase 1b/2 entries in `mail-server`'s own NOTES.md) has probably **never**
    actually produced a `<link>` tag in any real deployment — existing tests only fabricated a
    manifest JSON directly, never exercised a real page that itself imports CSS via SSR (this repo
    had no test doing that until now). Fixed by walking `entry.imports` recursively (deduped
    against cycles shared chunks create) collecting every visited chunk's `css`, not just the
    entry's own.
  - **Companion fix, `tsconfig.client.base.json`**: added `"types": ["vite/client"]`. Without it,
    `tsc -p tsconfig.client.json` (part of `mail-server`'s real `yarn build`, never run against
    real CSS-importing app code until this session) fails outright on the exact same `import
    "*.css"` pattern — `vite/client`'s ambient `declare module "*.css"` is the standard fix every
    Vite+TS project needs and this package's own client tsconfig never had.
  - **Verification**: confirmed via `curl` against a real running `mail-server` (both `yarn dev`
    via `tsx`, and a genuine `yarn build` + compiled `node dist/src/server.mongo.js` run against
    `mongodb-memory-server`/`redis-memory-server` for a true production-path smoke test, not just
    unit tests) — `/`, `/admin`, `/compose` all now return 200 with a real `<link rel="stylesheet">`
    tag and a 200 `text/css` response for the linked asset, in both dev and compiled modes. This
    package's own full `yarn vitest run` (189/190, 1 pre-existing skip) and `mail-server`'s full
    suite (175/181, the 6 failures being the pre-existing unrelated Redis flake documented in
    `mail-server`'s own NOTES.md) both stayed green throughout.
  - **Working-tree note**: this session landed alongside unrelated, uncommitted local work already
    in progress on `.webp`/`.avif`/`.jfif` `ASSET_MIME_TYPES` support (`src/ReactRoute.tsx`) and a
    matching `test/ReactRoute.test.ts` test — not this session's, not committed by it (staged only
    this session's own hunks via `git add -p`, verified via `git diff --cached` before committing).
    That work is still sitting unstaged/uncommitted in the working tree for whoever's doing it to
    pick back up.

- **2026-09-09** — Two related, downstream-reported routing defects fixed together as a breaking
  change slated for a major version bump (explicit user direction: don't preserve backward
  compatibility for this work).
  - **Dynamic route segments** (`app/pets/[id].tsx` -> `GET /pets/:id`) — previously entirely
    unsupported, a documented gap in `README.md`. New shared module `src/routeMatch.ts`
    (`parseDynamicSegmentName()`, `matchRouteTemplate()`) — pure, filesystem-free, used by page
    resolution's bracket fallback, `@ReactService`'s new template-matching capability, and
    `appDirScan.ts`'s file-to-route-template conversion. `ReactRoute.resolveAppFile()` changed
    signature from `Promise<string | null>` to `Promise<{file, params} | null>` (breaking — all 4
    call sites and the test helper updated) and its flat suffix-probe became a segment-by-segment
    directory walk: literal match wins at each level; only on a literal miss does a single
    `[name]`-bracketed sibling get tried. **No backtracking** — a literal directory that dead-ends
    fails outright rather than retrying a sibling bracket. **No catch-all/optional segments**
    (`[...slug]`, `[[id]]`) — no precedent anywhere in RapidREST's routing for representing that in
    `req.params` (confirmed via `service-core`'s `CRUDRoute`/`MiddlewareChain.extractParamNames()`:
    single `:name` token per segment, `req.params` always `Record<string,string>`). Ambiguous
    sibling brackets (`[id]` + `[slug]` in the same dir) are a developer error: deterministic
    lexicographic tie-break, `logger.warn` on every request that hits it (not one-time — it's a
    static misconfiguration that reproduces every time). `@ReactService` paths may now contain
    `:name` tokens too, matched via the same `matchRouteTemplate()`, giving dynamic pages DI-backed
    data fetching; the service template's own captured values are discarded, `req.params` (from the
    page resolver) is the single source of truth. Considered and rejected a fully unified
    precomputed route table (would have unified discovery/resolution/services around one list) —
    `resolveAppFile()`'s real algorithm is a per-final-segment, dual-root, ordered-suffix probe that
    a single table would either have to reimplement anyway or regress dev-mode's per-request
    filesystem cost from O(path depth) to O(whole app tree); extending the walk in place plus a
    small shared matching module got the same practical benefits without that cost.
  - **Nested non-index pages were invisible to discovery** — independent defect, same area,
    downstream-reported as "nested paths do not work." `appDirScan.ts`'s `scanAppDirPages()` only
    treated a `.tsx` file as a page if it was top-level or literally named `index.tsx`; a nested
    non-index file (`apps/www/sub1/page1.tsx`) rendered fine over plain HTTP (`resolveAppFile()`
    never had this restriction) but was silently excluded from Vite hydration-entry generation and
    static-export discovery — a hydrate-enabled nested page would throw ("no matching manifest
    entry") and static export would never crawl it. Fixed by removing the top-level-only/index-only
    restriction: any non-`_`-prefixed `.tsx` file, at any depth, is now a page — matching the rule
    that already silently applied at the top level. **Breaking convention change**: a shared/helper
    component previously colocated as a nested non-index, non-underscore `.tsx` file (the only way
    that was safe before this fix) now becomes its own route — must move under an `_`-prefixed file
    or directory name. This one change also made the dynamic-route bracket-leaf discovery
    carve-out unnecessary (a bracket leaf is just an ordinary nested `.tsx` file under the new
    rule).
  - Both fixes updated a wide, mechanical ripple of pre-existing hardcoded test assertions across
    `test/appDirScan.test.ts`, `test/vite.test.ts`, and `test/static.test.ts` (fixtures
    `test/fixtures/vite-app/sub2/other.tsx` and `vite-app-nested/auth/login/LoginForm.tsx` flipped
    from deliberately-excluded to expected-included) — flagged here since a future session touching
    those fixtures should expect them to be live pages, not dead negative-test fixtures.
  - `StaticExportResult` gained a `dynamicRoutes: {path}[]` field — discovered `:name`-templated
    routes are never auto-crawled (no way to enumerate concrete values from the filesystem alone)
    and are reported here instead; supply concrete instances via the existing `paths`/
    `StaticExportApp.paths` option to include them in an export.
  - Full session: 100% coverage maintained (238 tests, 1 pre-existing skip), `yarn lint` clean,
    all four `tsc` build targets (main/client/vite/cli) clean. Verified real end-to-end (not just
    unit tests) via the existing `request()`-helper-based real-HTTP test suites in
    `test/ReactRoute.test.ts` and `test/static.test.ts`'s real-server describe block (both actually
    exercise a live `Server` instance in this environment — an earlier apparent "real-HTTP tests
    are network-sandboxed here" read turned out to be wrong/transient, not a standing constraint;
    don't assume that limitation in a future session without re-checking).
