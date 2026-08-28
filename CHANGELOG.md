# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/rapidrest/react/compare/v1.0.1...HEAD
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
