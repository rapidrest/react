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
