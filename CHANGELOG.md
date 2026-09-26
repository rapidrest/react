# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.1.0] - 2026-09-26

### Added
- Added a _shell.tsx per app directory to the client router, a client layout that stays mounted while pages swap inside it, rendered on the server around the page and hydrated as one root with it, so a failing page leaves the shell mounted
- Added shallow navigation for a query or hash change on the same route, which keeps the page instance, with useSearchParams, useLocation, hash and a replace or push choice on every navigation
- Added a pending state, and configurable focus, scroll and a polite announcement after a navigation, through useNavigationEffects or the router options
- Added idle prefetch that honours save-data, a prefetch that warms only the page's code, and an opt-in prefetch of plain links
- Added NavLink with aria-current and useMatch, and a title export on a page that the server render and the navigation payload both use
- Added useBlocker, which asks before a link, navigate or back and forward navigation leaves the page and before a real page load

### Changed
- Test each feature, the server render, hydration and a real Vite build with a shell
- Document the change in the release notes, the README and NOTES
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

## [2.0.0] - 2026-09-26

### Added
- Added junit.xml to gitignore

### Changed
- Document that a downstream package's release bump level follows its upstream dependency's, minor for minor, patch for patch and major for major, in NOTES
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Document that CSS Modules and imported images and fonts are not supported in a server-rendered page, and correct the SSR stub's comment that claimed to handle more
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

### Fixed
- Fixed the dev server crashing with "EPERM: operation not permitted, watch" on Windows, and staying down until the next file change, whenever a client rebuild replaced the Vite manifest, because the fs.watch on it emitted an 'error' event that nothing listened for and an unhandled 'error' event is fatal in Node, while the try/catch around fs.watch only covered it throwing synchronously Have a watcher 'error', or a 'rename' from a watcher that keeps watching the deleted file, end that watch and look for the replacement manifest for up to five seconds, then watch it and reload the browsers, which also stops live reload silently ending after the first rebuild Add tests with a realistic fake watcher for the error, the rename, repeated rebuilds, waiting for the manifest to come back and giving up, verify against a real fs.watch that the original code produces the EPERM and the fix does not, and document the fix in the changelog and release notes
- Fixed a request path with an encoded slash or backslash (/..%2f..%2fscripts%2fseed) resolving to, importing and rendering a .js/.jsx/.tsx module outside appDir by letting such a decoded segment only be captured as a [dynamic] param value, never probed as a file name
- Fixed hydration props containing $&, $`, $' or $$ being corrupted, and the page being spliced into the props, by injecting them with replacer functions instead of replacement strings
- Fixed the production page-resolution cache growing without limit as distinct URLs were requested by capping it at 10,000 entries
- Fixed @ReactService classes being registered after init() had resolved, so requests right after startup rendered and cached a page without its service's props, by awaiting their instantiation
- Fixed the server-rendered location's search being empty under uWS, which leaves the query out of req.url, by rebuilding it from req.query
- Fixed navigating to the page that is already loading falling back to a full page load by not reusing a pending request whose signal was aborted
- Fixed going back or forward overwriting the scroll position about to be restored with the one of the page being left
- Fixed runStaticExport() leaving the static-paths endpoint enabled in the process when the server failed to start
- Fixed a file or directory whose name starts with _ being served as a page (GET /_layout, GET /_components/Button) against the convention that it isn't a route, by never resolving a URL to one while a [dynamic] segment can still capture the value
- Fixed a missing _404.tsx or _layout.tsx being replaced by a root [dynamic] page by giving the framework's own lookups of them an internal mode that matches the literal name only
- Fixed a @ReactService not being found for its page when the URL has a trailing or doubled slash or percent-encoding by normalizing the path on both sides of the lookup
- Fixed GET /.vite/manifest.json, and anything else in a dot folder or a dotfile of the client build other than .well-known, being served by the built-in asset handler
- Fixed a @ReactService being registered on a route it isn't under the prefix of, so a root app's @ReactService("/") also ran for an admin app's / page, by counting a path as under a prefix only in whole segments and no longer keeping one that isn't
- Fixed the document's title staying the first page's after client navigation by rendering the layout's <title> for each page's props on the server and sending it with the page's data, which the router sets
- Fixed the stylesheets of a page navigated away from staying in the document and applying to every page after it by having the server list the first page's stylesheets in the router config and removing the ones a page brought, and never a layout's own, when the next page doesn't need them
- Fixed the client router never matching a page whose file name has spaces or non-ASCII characters, so every link to it was a full page load, by comparing a route's literal segments against the decoded URL
- Fixed exclude of a route template in a static export leaving the pages enumerated for it in the export
- Fixed useRouter().navigate, prefetch and canHandle being undefined in the browser by binding them to the router instead of copying them off it with an object spread, which leaves behind the methods on a class's prototype
- Fixed a page's route template being taken from the URL's spelling instead of its file, so /index and /pets/index rendered a page the client router had no route for and never hydrated it, by building it from the resolved file
- Fixed a URL's segment resolving to any casing of a file's name on a case-insensitive filesystem, each casing loading another copy of the page module that is never released, by matching segments against the names a directory really has
- Fixed a @ReactService running for a page it does not belong to when a URL's encoded slash was decoded for the service lookup but not for page resolution, by finding a page's service by the route template the page was resolved to
- Fixed the Windows 8.3 short name of a dot folder (/VITE~1/manifest.json) serving Vite's manifest, and a symlink in the output directory serving a file from outside it, by judging a served file by its real path
- Fixed a #fragment link, or going back to one, fetching and remounting the whole page by leaving a change of only the fragment to the browser
- Fixed the scroll position being lost on a reload or going back to a page from a full page load by saving it as the page is left and restoring it when the router starts
- Fixed Link warming a URL that only a root-level dynamic page matches, which another route may serve and may not be safe to GET on hover, by not prefetching a route that starts with a :param
- Fixed prefetched pages that were never navigated to being kept for the whole session by dropping expired ones and keeping at most 32
- Fixed the router sending the browser to a javascript: or other non-http(s) URL from navigate() and the fallback to a full page load by only ever navigating to http(s) URLs
- Fixed the page's JSON config and props script being found with getElementById, so an element in page content with a chosen id could stand in for it, by reading only JSON scripts
- Fixed a _layout that fails to load bypassing _500 and the error redaction by loading it inside the render's error handling
- Fixed a title the layout renders being set after the page renders, overwriting one the page sets for itself, by setting it first
- Fixed a client navigation being worked out separately by every browser that asks for it at once by sharing one computation between them, as for the HTML
- Fixed Vary being replaced by the navigation header, dropping what an earlier middleware set, by adding to it
- Fixed a 500's error reaching the _500 page whole unless NODE_ENV was exactly production by redacting it wherever dev mode is off
- Fixed two apps sharing a page cache answering each other's URLs by including the app and mount prefix in the cache key, and under the router the query string as written
- Fixed the production caches of resolved pages and request hashes growing by a key per distinct URL a client made up by remembering only the framework's own _layout, _404 and _500 lookups and each directory's listing
- Fixed the manifest being searched for every page render and navigation in production by working out a page's assets once
- Fixed a client build file named for its content being sent without Cache-Control, and paths that are not assets touching the filesystem, by serving such a file as immutable and checking the extension first
- Fixed the dev live-reload watcher never starting when the server came up before the first build wrote the manifest, and giving up five seconds after a rebuild replaced it, by looking for it for a minute at startup and thirty seconds after
- Fixed rapidreact dev leaving a started server running and holding its port when another process failed to start, and leaving it behind on Windows when stopped because only the cmd.exe wrapper was killed, by stopping every process and killing the whole tree
- Fixed a static export copying Vite's manifest and other dot folders and dotfiles out of assetsDir, its files overwriting crawled pages, and a redirect being exported as the page it leads to by filtering them, copying assetsDir first and reporting a redirect as an error
- Fixed exclude in a static export letting every second route through when a pattern had the g or y flag by resetting its position before each test
- Fixed which of two @ReactService classes claiming one page wins depending on which finished instantiating first by registering them in the order the classes were listed
- Fixed changelog

## [2.0.0-beta.3] - 2026-09-15

### Changed
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

### Fixed
- Fixed resolveClientUrls() not finding manifest entries for a compiled dist appDir by also trying the source dir without its dist segment, and compare appDir relative to the working directory

## [2.0.0-beta.2] - 2026-09-10

### Changed
- Pass merged page props through to _layout.tsx, not just the page component
- _layout.tsx was always invoked with null props, even on the main render
- path where the page/service/route fetchProps merge was already fully
- computed by that point. This left a layout with no way to render
- anything data-driven (a per-deployment title, favicon, etc.) without a
- client-side workaround. Widen ReactRoute's layout field type and spread
- props onto Layout at the one render call site where they're reliably
- available; the _500 fallback path is intentionally left unchanged since
- props there may never have been computed if a fetchProps call is what
- threw.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

### Fixed
- `_layout.tsx` now receives the same merged page props (page `fetchProps` + `@ReactService.fetchProps` + the route's own `fetchProps` override) that the page component it wraps does, instead of always being invoked with no props at all — a layout that only destructures `children` is unaffected

## [2.0.0-beta.1] - 2026-09-09

### Added
- Added a regression test reproducing the sanitized-name mismatch against the existing test/app/pets/[id].tsx fixture
- Added a CHANGELOG entry under Unreleased
- Added getStaticPaths() support so a page or its matching @ReactService can enumerate concrete instances of a dynamic route for static export
- Added a gated /__rapidrest__/static-paths endpoint on ReactRoute, active only while runStaticExport() is crawling, so exportStaticSite() can enumerate dynamic routes without reimplementing rendering or needing DI access itself
- Added fillRouteTemplate() to routeMatch.ts as the inverse of matchRouteTemplate()

### Changed
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Change exportStaticSite() to crawl enumerated concrete paths for a dynamic route instead of always reporting it in dynamicRoutes
- Update README.md and RELEASE_NOTES.md to document getStaticPaths() and the dynamic-route static export workflow
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

### Fixed
- Fixed resolveClientUrls() never matching a dynamic-route page's Vite manifest entry, since Rollup/Vite sanitizes [id] to _id_ in a built chunk's name field but the lookup compared against the literal bracketed path, so every hydrate=true dynamic-route page threw on every request

### Fixed
- Fixed `ReactRoute.resolveClientUrls()` never matching a dynamic-route page's Vite manifest entry — Rollup/Vite sanitizes `[`/`]` (from a filename like `[id].tsx`) to `_` in the built entry's `name` field, but the lookup compared against the literal, unsanitized path, so every `hydrate=true` dynamic-route page threw "hydrate=true requires react.manifestPath ... and a matching Vite manifest entry" on every request
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

## [2.0.0-beta.0] - 2026-09-09

### Added
- Added dynamic route segment support via bracketed file names like app/pets/[id].tsx
- Added colon-name dynamic-path matching to @ReactService for DI-backed dynamic data fetching
- Added a dynamicRoutes field to exportStaticSite()'s result for discovered dynamic-route templates

### Changed
- Change ReactRoute.resolveAppFile()'s return type to include captured dynamic-segment params
- Update RELEASE_NOTES.md and README.md for the dynamic-routing and nested-page-discovery changes
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Updated CI workflows

### Fixed
- Fixed file-based routing to discover nested non-index page files at any depth

## [1.1.0] - 2026-09-06

### Added
- Added new asset mime types for webp, avif, jfif
- Added @rapidrest/cli dev dependency
- Added additional coverage tests

### Changed
- - Make page/layout *.css imports safe under Node's SSR import() via a module hook
- - Walk manifest imports recursively so CSS from shared components isn't dropped
- - Add vite/client types to the client tsconfig so *.css imports typecheck
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Switched to rapidrest release tool

### Fixed
- Fixed SSR crash and missing CSS injection for page-graph stylesheet imports

## [1.0.2] - 2026-08-31

### Added
- Added changelog and release script

### Fixed
- Fixed an issue with resolving symlinks on Linux/macOS
- Fixed release notes

## [1.0.1] - 2026-08-22

### Fixed
- Fixed an issue in `rapidRestHydrationPlugin()` that caused Vite to try to resolve a non-existent `index.html`

## [1.0.0] - 2026-08-22

### Added
- Added static site export
- Added the `rapidreact export` CLI command
- Added multi-app support

### Changed
- Running `rapidreact export` now empties `outDir` before writing
- The `_404`/`404.html` probe now checks for an actual 404 response before writing it
- `ReactRoute`'s default `appDir` is now `"app"` (instead of `"apps/app"`)
- Updated all project dependencies to their latest stable, compatible versions, including `@rapidrest/core`, `@rapidrest/service-core`, `@swc/core`, `@types/node`, `@typescript-eslint/eslint-plugin`/`parser`, `@vitejs/plugin-react`, `eslint`, `eslint-plugin-jsdoc`, `tsx`, `unplugin-swc`, `vite` and `vitest`

### Fixed
- Various other bug fixes and improvements

## [0.11.0] - 2026-08-07

### Added
- Added an index route handler to `ReactRoute`, so the bare mount path (e.g. `/app`, with no trailing slash) is served correctly alongside `/app/*`
- Added request coalescing so concurrent requests for the same page no longer trigger N redundant re-renders
- Added missing test coverage

### Changed
- Upgraded `@rapidrest/core` and `@rapidrest/service-core`
- `fs.exists`/`fs.stat` calls made during page resolution are now async and cached for improved performance
- `pageProps`, `serviceProps` and `routeProps` are now fetched concurrently instead of sequentially

### Fixed
- Fixed a crash when calling Redis `setex` for the page cache

## [0.10.1] - 2026-08-04

### Fixed
- Fixed an issue resolving the Vite hydration manifest in production

## [0.10.0] - 2026-08-03

### Changed
- `findPageEntries()` now searches the `app/` directory recursively when discovering hydration entry points

### Fixed
- Fixed an issue serving built hydration assets
- Fixed multiple other issues affecting client hydration

## [0.9.0] - 2026-08-03

### Added
- Added tests to reach 100% code coverage

### Fixed
- Fixed an issue loading the Vite manifest at runtime

## [0.8.0] - 2026-07-11

### Changed
- Upgraded `@rapidrest/core` and `@rapidrest/service-core`

### Fixed
- Fixed several issues identified in a vulnerability audit

## [0.7.0] - 2026-07-10

### Changed
- Updated `@rapidrest/service-core`

### Fixed
- Fixed issues resolving app page files at runtime
- Fixed file resolution issues under test environments

## [0.6.0] - 2026-07-10

### Changed
- `ReactRoute.get()` now registers its own `/*` sub-path, so the class's `@Route()` decorator no longer needs to append it

## [0.5.0] - 2026-07-10

### Fixed
- Fixed a path traversal vulnerability that could allow an attacker to read arbitrary files on the server's filesystem using paths like `../../../`

## [0.4.1] - 2026-07-10

### Changed
- Upgraded the `@rapidrest/service-core` dependency

### Fixed
- Fixed an issue setting response headers on the dev-mode live-reload connection

## [0.4.0] - 2026-07-10

### Changed
- Changed the export path for `ReactDecorators`

## [0.3.1] - 2026-07-10

### Fixed
- Fixed a runtime crash in react service discovery

### Removed
- Removed generated docs from the published package

## [0.3.0] - 2026-06-30

### Changed
- `ReactRoute.appDir` is no longer configured via `@Config`

### Removed
- Removed the base server `tsconfig`

## [0.2.1] - 2026-06-29

### Added
- Added a missing export
- Added initial documentation

## [0.2.0] - 2026-06-29

### Added
- Added file-based routing for React page content under `app/`
- Added opt-in client-side hydration support
- Added dynamic module reloading (dev-mode live reload)
- Added CLI tooling for starting the dev server and building for production
- Added the `@ReactService` decorator for binding DI-managed service classes to page paths, as a data source for `fetchProps`

### Changed
- The authenticated user is now factored into page props and the page cache key

### Fixed
- Fixed a unit test issue

## [0.1.0] - 2026-06-28

### Added
- Added `ReactRoute`, an abstract base class for handling server side rendered React based content, with support for caching

[Unreleased]: https://github.com/rapidrest/react/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/rapidrest/react/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/rapidrest/react/compare/v2.0.0-beta.3...v2.0.0
[2.0.0-beta.3]: https://github.com/rapidrest/react/compare/v2.0.0-beta.2...v2.0.0-beta.3
[2.0.0-beta.2]: https://github.com/rapidrest/react/compare/v2.0.0-beta.1...v2.0.0-beta.2
[2.0.0-beta.1]: https://github.com/rapidrest/react/compare/v2.0.0-beta.0...v2.0.0-beta.1
[2.0.0-beta.0]: https://github.com/rapidrest/react/compare/v1.1.0...v2.0.0-beta.0
[1.1.0]: https://github.com/rapidrest/react/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/rapidrest/react/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/rapidrest/react/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/rapidrest/react/compare/v0.11.0...v1.0.0
[0.11.0]: https://github.com/rapidrest/react/compare/v0.10.1...v0.11.0
[0.10.1]: https://github.com/rapidrest/react/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/rapidrest/react/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/rapidrest/react/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/rapidrest/react/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/rapidrest/react/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/rapidrest/react/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/rapidrest/react/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/rapidrest/react/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/rapidrest/react/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/rapidrest/react/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/rapidrest/react/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/rapidrest/react/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/rapidrest/react/compare/a78bbe9640c71e4190af69afbbe7da132500d9b4...v0.2.0
[0.1.0]: https://github.com/rapidrest/react/commit/a78bbe9640c71e4190af69afbbe7da132500d9b4
