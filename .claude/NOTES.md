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

- **Commit discipline.** Don't `git commit` unless explicitly asked, even after a full
  review-and-fix cycle with passing tests. Leave changes staged/unstaged and say so.

- **Commit message style: concise, one line per task/bug/feature — no verbose prose.** A commit
  message is a short list of one-line bullets, one per item. Never a paragraph explaining what was
  done or why for any single item — that belongs in the diff/code comments/NOTES.md, not the commit
  message. This mirrors JP's standing convention across his other repos.

- **Static export architecture: crawl the real server over real HTTP, never reimplement
  `ReactRoute`'s rendering.** `exportStaticSite()`/`runStaticExport()` (`src/static.ts`) boot the
  app's actual server (real DI, real config, real `@ReactService`s) and crawl it with `fetch()`,
  writing whatever HTML it actually returns. This is deliberate: the exported output can never
  diverge from what a live deployment serves, at the cost of route *discovery* (which pages
  exist) being a separate, independently-maintained convention (`appDirScan.ts`/`fileToRoute()`)
  from *resolution* (`ReactRoute.resolveAppFile()`) — the two can drift if the file-resolution
  convention ever changes without a matching update to discovery. Known, accepted gap.

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
