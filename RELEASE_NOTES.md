# Release Notes

## Unreleased

### Added

* **Client-side navigation, as a progressive enhancement of server rendering.** Set `router = true` on a
  `ReactRoute` and build the client with `createViteConfig({ router: true })`. Every URL is still rendered on the
  server in full, so first loads, reloads, crawlers and no-JavaScript browsers are unchanged; after the first load,
  clicks between the app's pages fetch that page's data (the same URL, requested as JSON with an
  `X-Rapidrest-Navigation` header) and swap the page in without loading a document. It is built on the file routes
  you already have — no route table to maintain, no router dependency — and `_layout.tsx` stays the server-rendered
  document around the page.
  * `Link` (prefetches on hover and focus), `useRouter()`, `usePathname()` and `useParams()` are exported from
    `@rapidrest/react/client`; ordinary `<a href>` links work as well.
  * Anything the router can't be sure of is left to the browser: modified clicks, `target`/`download`/
    `rel="external"`, other origins or apps, URLs with no page, redirects, error statuses, and pages that fail to load
    or render.
  * Back/forward and scroll position are restored, and only the latest of overlapping navigations is applied.
  * What to know when adopting it: the JSON responses carry `Vary: X-Rapidrest-Navigation`, so a cache or CDN in
    front of the app must respect `Vary`; and the layout doesn't re-render between pages, so keep per-page content
    (including `<title>`) in the pages.

### Changed

* `ReactRoute` finds a page's Vite manifest entry by the entry's name first and its source path second.

### Fixed

* **The dev server crashed with `Error: EPERM: operation not permitted, watch` on Windows whenever the client was
  rebuilt, and stayed down until the next file change** — so the browser hung, loading forever, until something else
  touched a file. `ReactRoute` watches the Vite manifest to tell connected browsers to reload after each build. A
  build *replaces* the manifest, and the `fs.watch` watcher answers that with an `'error'` event that nothing was
  listening for; an unhandled `'error'` event is fatal in Node, and the `try/catch` around `fs.watch` only ever
  covered it throwing synchronously. Now a watcher `'error'` ends that watch and looks for the new manifest (for up to
  five seconds, as the build deletes the old one a moment before writing the next), then watches that and reloads the
  browsers.
* **Live reload could stop after the first rebuild.** Where the watcher doesn't error but keeps watching the manifest
  that was replaced (it reports a `'rename'`), it never heard about any later build. A `'rename'` now also re-watches
  the new file.
* **A request path with an encoded slash or backslash could load a module from outside `appDir`.** Page resolution
  rejected `.` and `..` segments but not a segment such as `..%2f..%2fscripts%2fseed`, which decodes to a path that
  leaves the app directory; the server would `import()` any `.js`, `.jsx` or `.tsx` file found there (running its
  top-level code) and render its default export. A decoded segment containing `/`, `\` or a NUL can now only be
  captured as the value of a `[dynamic]` segment (`/files/a%2Fb` still gives `id = "a/b"`), never used as a file name.
* Hydration props containing `$&`, `` $` ``, `$'` or `$$` were mangled — and could pull the whole page into the props
  script — because they were spliced in with `String.replace` and a replacement string. They are now inserted verbatim.
* The production page-resolution cache is capped at 10,000 entries instead of growing with every distinct URL.
* `@ReactService` classes are now registered before `init()` resolves, so the first requests after startup no longer
  render (and cache) a page without its service's props.
* The server-rendered location's `search` is no longer empty under uWS, which leaves the query out of `req.url`, so
  `useRouter().search` renders the same on the server as in the browser.
* Client navigation: navigating to a page that is already loading no longer falls back to a full page load, and going
  back or forward no longer overwrites the scroll position about to be restored.
* `runStaticExport()` no longer leaves the static-paths endpoint enabled when the server fails to start.
* **A file or directory starting with `_` is no longer served as a page.** The convention (`_layout`, `_404`, `_500`, and
  helper components you keep next to your pages) has always been that such a name isn't a route, and page discovery,
  Vite entries and static export honoured it — but a request for `/_layout` or `/_components/Button` still rendered the
  file, running its `fetchProps()`, and under hydration or the router logged a manifest error on every hit. Those URLs
  now answer 404. The framework's own lookups of `_layout`, `_404` and `_500` are unaffected. If you relied on a `_`
  page being reachable by URL, rename it. (`ReactRoute.resolveAppFile()` gained an optional third parameter, `internal`,
  for those lookups; subclasses overriding it with two parameters keep working.)
* A missing `_404.tsx`/`_layout.tsx` is no longer stood in for by a root-level `[dynamic]` page.
* A `@ReactService` is now found however its page's URL is written: `/pets/`, `//pets` and `/%70ets` reach the service
  registered at `/pets`, as they reach the page, instead of rendering the page without the service's props.

## v2.0.0-beta.3

* Fixed `ReactRoute.resolveClientUrls()` never finding the Vite manifest entry for a page whose `appDir` points at a
  compiled copy of its sources, such as a package's `node_modules/<pkg>/dist/apps/www` built by Vite from
  `node_modules/<pkg>/apps/www`. Every `hydrate=true` page served that way threw, so the page returned 500 in
  production. When no entry matches under `appDir`, the lookup now also tries `appDir` with its last `dist` segment
  removed; an entry named after `appDir` itself still wins
* Fixed `appDir` values written as `./apps/www` or as an absolute path not matching manifest entries; `appDir` is now
  compared relative to the working directory

## v2.0.0-beta.2

* Fixed `_layout.tsx` never receiving the resolved page props (from a page's own `fetchProps`, a
  matching `@ReactService`, or the route's own `fetchProps` override) — it was always rendered with
  no props at all, even though the exact same data was already being computed for the page component
  it wraps. A layout can now read that data directly (e.g. to render a per-deployment `<title>` or
  favicon `<link>` server-side, with no client-side flash)

## v2.0.0-beta.1

* Added `getStaticPaths()` support for [dynamic routes](README.md#dynamic-routes): a page and/or
  its matching `@ReactService` can now enumerate the concrete instances of a dynamic route (e.g.
  `/pets/1`, `/pets/2`) to include in a static export, instead of the route always being dropped
  and only reported via `dynamicRoutes`
* Fixed `ReactRoute.resolveClientUrls()` never matching a dynamic-route page's Vite manifest
  entry — Rollup/Vite sanitizes `[`/`]` (from a filename like `[id].tsx`) to `_` in the built
  entry's `name` field, but the lookup compared against the literal, unsanitized path, so every
  `hydrate=true` dynamic-route page threw on every request

## v2.0.0-beta.0

* Added support for dynamic route segments (e.g. `app/pets/[id].tsx` or `app/pets/[id]/index.tsx`
  serving `GET /pets/:id`), with the captured value exposed via `req.params`/`props.params`
* Added `:name` dynamic-path support to `@ReactService`, so dynamic pages can use DI-backed data
  fetching the same way static pages do
* Added a `dynamicRoutes` field to `exportStaticSite()`'s result, reporting discovered
  dynamic-route templates that aren't auto-crawled — supply concrete instances via `paths`/
  `StaticExportApp.paths` to include them in a static export
* Fixed file-based routing to discover nested, non-index page files at any depth (previously only
  a top-level `.tsx` file or a nested `index.tsx` was discovered for hydration entries and static
  export; other nested files rendered fine over HTTP but were silently missing from both) — any
  non-`_`-prefixed `.tsx` file at any depth is now a page
* **Breaking:** a nested `.tsx` file that isn't named `index.tsx` is no longer silently excluded —
  it is now its own route. A non-page component colocated under `appDir` must be moved under an
  `_`-prefixed file or directory name
* **Breaking:** `ReactRoute.resolveAppFile()` (protected) now returns
  `{ file: string; params: Record<string, string> } | null` instead of `string | null`

## v1.1.0

* Added asset MIME types: webp, avif, jfif
* Fixed crash with SSR
* Fixed multiple issues with CSS injection

## v1.0.2

* Fixed an issue with resolving symlinks on Linux/macOS

## v1.0.1

* Fixed issue with `rapidRestHydrationPlugin()` that caused Vite to try to resolve a non-existant `index.html`

## v1.0.0

* Added static site export
* Added the `rapidreact export` CLI command
* Added multi-app support
* Running `rapidreact export` now empties `outDir` before writing
* The `_404`/`404.html` probe now checks for an actual 404 response before writing it
* `ReactRoute`'s default `appDir` is now `"app"` (instead of `"apps/app"`)
* Updated all project dependencies to their latest stable, compatible versions, including `@rapidrest/core`, `@rapidrest/service-core`,
  `@swc/core`, `@types/node`, `@typescript-eslint/eslint-plugin`/`parser`, `@vitejs/plugin-react`, `eslint`,
  `eslint-plugin-jsdoc`, `tsx`, `unplugin-swc`, `vite` and `vitest`
* Various other bug fixes and improvements

## v0.11.0

* Added an index route handler to `ReactRoute`, so the bare mount path (e.g. `/app`, with no
  trailing slash) is served correctly alongside `/app/*`
* Upgraded `@rapidrest/core` and `@rapidrest/service-core`
* Fixed a crash when calling Redis `setex` for the page cache
* `fs.exists`/`fs.stat` calls made during page resolution are now async and cached for improved
  performance
* Added request coalescing so concurrent requests for the same page no longer trigger N redundant
  re-renders
* `pageProps`, `serviceProps` and `routeProps` are now fetched concurrently instead of sequentially
* Added missing test coverage

## v0.10.1

* Fixed an issue resolving the Vite hydration manifest in production

## v0.10.0

* `findPageEntries()` now searches the `app/` directory recursively when discovering hydration
  entry points
* Fixed an issue serving built hydration assets
* Fixed multiple other issues affecting client hydration

## v0.9.0

* Fixed an issue loading the Vite manifest at runtime
* Added tests to reach 100% code coverage

## v0.8.0

* Fixed several issues identified in a vulnerability audit
* Upgraded `@rapidrest/core` and `@rapidrest/service-core`

## v0.7.0

* Fixed issues resolving app page files at runtime
* Fixed file resolution issues under test environments
* Updated `@rapidrest/service-core`

## v0.6.0

* `ReactRoute.get()` now registers its own `/*` sub-path, so the class's `@Route()` decorator no
  longer needs to append it

## v0.5.0

* Fixed a path traversal vulnerability that could allow an attacker to read arbitrary files on the
  server's filesystem using paths like `../../../`

## v0.4.1

* Upgraded the `@rapidrest/service-core` dependency
* Fixed an issue setting response headers on the dev-mode live-reload connection

## v0.4.0

* Changed the export path for `ReactDecorators`

## v0.3.1

* Fixed a runtime crash in react service discovery
* Removed generated docs from the published package

## v0.3.0

* `ReactRoute.appDir` is no longer configured via `@Config`
* Removed the base server `tsconfig`

## v0.2.1

* Added a missing export and initial documentation

## v0.2.0

* Added file-based routing for React page content under `app/`
* Added opt-in client-side hydration support
* Added dynamic module reloading (dev-mode live reload)
* Added CLI tooling for starting the dev server and building for production
* Added the `@ReactService` decorator for binding DI-managed service classes to page paths, as a
  data source for `fetchProps`
* The authenticated user is now factored into page props and the page cache key
* Fixed a unit test issue

## v0.1.0

- `ReactRoute` - An abstract base class for handling server side rendered React based content. Supports caching.
