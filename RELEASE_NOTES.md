# Release Notes

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
