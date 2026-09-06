///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Node module customization hook (registered via `register()` in `ReactRoute.tsx`) that makes a
 * plain `import "*.css"` (and other static-asset extensions) a safe no-op when a page/layout
 * module gets loaded via `import()` for server-side rendering.
 *
 * This is what makes this package's documented "import your stylesheet anywhere in the entry's
 * module graph" pattern (used so Vite's build can discover which CSS belongs to which client
 * entry, for the manifest-based `<link>` injection `ReactRoute`'s `callResolveClientUrls` does)
 * safe for SSR too — without this, the exact same source file Vite happily bundles for the
 * browser crashes the moment `ReactRoute.renderPage()`'s `import()` loads it in Node.
 *
 * Two failure modes, both handled here:
 * - Running from TypeScript source (`tsx` dev, or a test runner importing `.tsx` directly): the
 * `.css` file exists on disk at the referenced path, so `resolve` succeeds, but `load` then
 * throws `ERR_UNKNOWN_FILE_EXTENSION` — Node's default loader has no format registered for `.css`.
 * - Running compiled (production `dist/`): `tsc` only ever emits `.js` for `.ts`/`.tsx` sources —
 * a `.css` sibling is never copied into `dist/`, so `resolve` itself fails with
 * `ERR_MODULE_NOT_FOUND` before `load` is ever reached, regardless of any `load` hook.
 *
 * The `resolve` hook here intercepts *before* Node tries to find the file on disk at all,
 * redirecting matching specifiers to a synthetic `css-stub:` URL that always resolves — `load`
 * then recognizes that scheme and returns an empty module, never touching the filesystem.
 *
 * Runs in Node's dedicated loader thread (a separate realm from the rest of this package), so it
 * must be fully self-contained — no importing anything from `ReactRoute.tsx` or sharing state.
 *
 * @author Jean-Philippe Steinmetz
 */
const STATIC_ASSET_EXTENSIONS = [".css", ".scss", ".sass", ".less"];
const STUB_SCHEME = "css-stub:";

export interface ResolveContext {
    conditions: string[];
    importAttributes: Record<string, string>;
    parentURL?: string;
}

export interface ResolveResult {
    url: string;
    shortCircuit?: boolean;
}

export interface LoadContext {
    format?: string | null;
    importAttributes: Record<string, string>;
}

export interface LoadResult {
    format: string;
    shortCircuit?: boolean;
    source: string;
}

export async function resolve(
    specifier: string,
    context: ResolveContext,
    nextResolve: (specifier: string, context: ResolveContext) => Promise<ResolveResult>,
): Promise<ResolveResult> {
    if (STATIC_ASSET_EXTENSIONS.some((ext) => specifier.endsWith(ext))) {
        return { url: `${STUB_SCHEME}${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}

export async function load(
    url: string,
    context: LoadContext,
    nextLoad: (url: string, context: LoadContext) => Promise<LoadResult>,
): Promise<LoadResult> {
    if (url.startsWith(STUB_SCHEME)) {
        return { format: "module", shortCircuit: true, source: "export default {};" };
    }
    return nextLoad(url, context);
}
