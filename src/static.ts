///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import fs from "node:fs";
import path from "node:path";
import { Server, type ServerOptions } from "@rapidrest/service-core";
import { fileToRouteTemplate, scanAppDirPages } from "./appDirScan.js";
import { STATIC_EXPORT_ENV_VAR, STATIC_PATHS_ROUTE } from "./routeMatch.js";

/** A guaranteed-unmatched path used to probe the app's real `_404` page during export. */
const NOT_FOUND_PROBE = "/__rapidrest_static_export_404_probe__";

/** One app's crawl configuration, for exporting a multi-app project in a single call. */
export interface StaticExportApp {
    /** Filesystem path to this app's directory, relative to cwd. */
    appDir: string;
    /** URL prefix this app's React route is mounted at. In the multi-app `apps` form, also
     * becomes this app's output subdirectory prefix, so routes from different apps can't
     * collide in `outDir` and the exported site preserves each app's mount-relative structure
     * (e.g. an admin app mounted at `/admin` writes to `<outDir>/admin/...`). Use `""` — not
     * `"/"` — for an app mounted at the site root; `routePrefix` is concatenated directly with
     * each route (which already starts with `/`), so a `"/"` prefix produces a double slash.
     * Default `""`. */
    routePrefix?: string;
    /** Extra prefix-free route paths to crawl for this app, beyond what `appDir` discovers. */
    paths?: string[];
    /** Route paths to skip for this app (e.g. auth-gated/personalized pages that shouldn't be
     * baked into a public static export). Matched against the prefix-free route path. */
    exclude?: (string | RegExp)[];
}

export interface StaticExportOptions {
    /** Port of the already-running server to crawl. */
    port: number;
    /** Host of the already-running server to crawl. Default `"127.0.0.1"`. */
    host?: string;
    /** Filesystem path to the app directory, relative to cwd. Ignored when `apps` is given.
     * Unlike `StaticExportApp.routePrefix`, this single-app `routePrefix` is never part of the
     * output path — the export always serves this app from the site root. Default `"app"`. */
    appDir?: string;
    /** URL prefix the React route is mounted at (e.g. `"/app"`). Prepended only to the
     * fetch URL — discovered/explicit route paths are always prefix-free. Ignored when `apps`
     * is given. Default `""`. */
    routePrefix?: string;
    /** Extra prefix-free route paths to crawl, beyond what `appDir` convention discovers.
     * Ignored when `apps` is given. */
    paths?: string[];
    /** Route paths to skip. Ignored when `apps` is given. */
    exclude?: (string | RegExp)[];
    /** Crawl multiple apps in one export — each with its own `appDir`/`routePrefix`/`paths`/
     * `exclude` — instead of the single-app `appDir`/`routePrefix`/`paths`/`exclude` fields
     * above. `outDir` is still cleaned exactly once regardless of app count. */
    apps?: StaticExportApp[];
    /** Directory to write the exported static site to. Default `"dist/export"`. */
    outDir?: string;
    /** Directory of built hydration/static assets, copied verbatim into `outDir`.
     * Default `"dist/public"`. */
    assetsDir?: string;
    /** Probe and write the app's real `_404` page to `<outDir>/404.html`. In the multi-app
     * `apps` form, the first app in the list is authoritative for this site-wide fallback.
     * Default `true`. */
    notFound?: boolean;
    /** Maximum number of pages to crawl concurrently, across all apps. Default `5`. */
    concurrency?: number;
}

export interface StaticExportResult {
    pages: { path: string; outFile: string; status: number }[];
    errors: { path: string; status?: number; error?: string }[];
    /** Discovered dynamic-route templates (e.g. `/pets/:id`) that were not exported — either
     * nothing in the app could enumerate concrete instances of them (no page or matching
     * `@ReactService` implements `getStaticPaths()`; see `ReactRoute`), or the app couldn't be
     * asked at all (the crawled server wasn't started via `runStaticExport()`, so the
     * enumeration endpoint was never active). Supply concrete instances via `paths`/
     * `StaticExportApp.paths` (e.g. `paths: ["/pets/1", "/pets/2"]`) to include them in the
     * export anyway; a template excluded via `exclude` never appears here either, since it was
     * deliberately opted out rather than merely left un-enumerable. */
    dynamicRoutes: { path: string }[];
}

/**
 * Discovers the route paths served by `appDir`, matching the same file convention
 * `vite.ts` uses to discover hydration entry points and `ReactRoute.resolveAppFile()` uses to
 * resolve them at request time (`fileToRouteTemplate()` in `appDirScan.ts`).
 *
 * `app/pets.tsx` and `app/pets/index.tsx` both legitimately serve `/pets` (per
 * `ReactRoute.resolveAppFile()`'s own suffix-trial order) — when both exist, they map to
 * the same route path here and are deduplicated. Which underlying file backs a route is
 * irrelevant to discovery itself: the live server (crawled over real HTTP by
 * `exportStaticSite()`) is the one that resolves the file for each request, exactly as it
 * would for a normal, non-exported deployment.
 *
 * A dynamic route (`app/pets/[id].tsx`) is discovered as its `:id`-templated form (`/pets/:id`) —
 * see `exportStaticSite()` for how it is split out of the crawlable route set.
 */
export function discoverRoutes(appDir: string): string[] {
    return [...new Set(scanAppDirPages(appDir).map(fileToRouteTemplate))];
}

/**
 * Writes `html` to the output file for `outputPrefix + route`, creating parent directories as
 * needed. Refuses to write outside `outDir` — `route` may originate from caller-supplied
 * `paths`, so it's untrusted the same way a URL segment is, and gets the same containment check
 * `ReactRoute.resolveAppFile()`/`tryServeAsset()` apply to theirs. The check runs against the
 * final resolved path, so it also covers a malformed `outputPrefix`, not just `route`.
 */
function writeRouteHtml(outDir: string, outputPrefix: string, route: string, html: string): string {
    const root = path.resolve(outDir);
    const outFile = path.resolve(path.join(outDir, outputPrefix, route, "index.html"));
    if (!outFile.startsWith(root + path.sep)) {
        throw new Error(`[rapidreact] Refusing to write outside outDir for route "${route}"`);
    }
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, html);
    return outFile;
}

/** Runs `tasks` with at most `concurrency` in flight at once. */
async function runWithConcurrency<T>(items: T[], concurrency: number, task: (item: T) => Promise<void>): Promise<void> {
    let index = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
        while (index < items.length) {
            const item = items[index++];
            await task(item);
        }
    });
    await Promise.all(workers);
}

/**
 * Crawls every page served by an already-running server and writes the rendered output to
 * `outDir` as a static site — plain HTML/CSS/JS, deployable to any static host with no
 * server required at request time.
 *
 * Reuses the real server's rendering pipeline over real HTTP (rather than reimplementing
 * `ReactRoute`'s rendering logic), so the exported output can never diverge from what the
 * live server actually serves. Props are frozen at export time: pages whose `fetchProps`/
 * `@ReactService` depend on per-request or authenticated state will bake in whatever an
 * unauthenticated crawl request renders — use `exclude` for personalized pages.
 *
 * Hydration asset URLs injected by `ReactRoute` are always root-absolute, so this only
 * produces a working site when it will be served from `/` (the same pre-existing
 * constraint `ReactRoute`'s hydration feature already has in a live deployment).
 *
 * @example
 * ```ts
 * // src/export.ts
 * import { Logger } from "@rapidrest/core";
 * import { ObjectFactory } from "@rapidrest/service-core";
 * import { runStaticExport } from "@rapidrest/react";
 * import config from "./config.js";
 *
 * const logger = Logger();
 * const objectFactory = new ObjectFactory(config, logger);
 * const result = await runStaticExport(
 *     { config, basePath: ".", logger, objectFactory },
 *     { appDir: "app", routePrefix: "/app", outDir: "dist/export" }
 * );
 * await objectFactory.destroy();
 *
 * if (result.errors.length > 0) {
 *     console.error(`[export] Completed with ${result.errors.length} error(s).`);
 *     process.exit(1);
 * }
 * console.log(`[export] Wrote ${result.pages.length} page(s) to dist/export.`);
 * ```
 *
 * @example
 * ```ts
 * // Multi-app project — writes www's pages to dist/export/, admin's to dist/export/admin/
 * await exportStaticSite({
 *     port,
 *     apps: [
 *         { appDir: "apps/www", routePrefix: "" },
 *         { appDir: "apps/admin", routePrefix: "/admin" },
 *     ],
 * });
 * ```
 */
export async function exportStaticSite(options: StaticExportOptions): Promise<StaticExportResult> {
    const {
        port,
        host = "127.0.0.1",
        outDir = "dist/export",
        assetsDir = "dist/public",
        notFound = true,
        concurrency = 5,
    } = options;

    // The multi-app form is opted into explicitly — even a single-entry `apps` array applies
    // output-prefixing, since the caller chose the multi-app-aware shape on purpose. Otherwise
    // synthesize one app from the flat single-app fields, matching today's behavior exactly.
    const isMultiAppForm = options.apps !== undefined;
    const apps: StaticExportApp[] = isMultiAppForm
        ? options.apps!
        : [{
              appDir: options.appDir ?? "app",
              routePrefix: options.routePrefix ?? "",
              paths: options.paths ?? [],
              exclude: options.exclude ?? [],
          }];

    const baseUrl = `http://${host}:${port}`;

    interface CrawlTask {
        route: string;
        fetchPrefix: string;
        outputPrefix: string;
    }
    const tasks: CrawlTask[] = [];
    const result: StaticExportResult = { pages: [], errors: [], dynamicRoutes: [] };
    for (const app of apps) {
        const fetchPrefix = app.routePrefix ?? "";
        const outputPrefix = isMultiAppForm ? fetchPrefix : "";
        const appExclude = app.exclude ?? [];
        const isExcluded = (route: string) =>
            appExclude.some((pattern) => (typeof pattern === "string" ? pattern === route : pattern.test(route)));

        // A discovered route template (e.g. "/pets/:id") can't be fetched as a literal URL by
        // itself — ask the live app (real DI, real config) which concrete instances of it it can
        // enumerate, via ReactRoute's STATIC_PATHS_ROUTE endpoint (a page's own `getStaticPaths()`
        // and/or a matching `@ReactService`'s). `app.paths` entries are the developer's own
        // concrete instantiations and are never treated as templates, even if one happened to
        // contain ":".
        const discovered = discoverRoutes(app.appDir);
        const discoveredConcrete = discovered.filter((route) => !route.includes(":"));
        const discoveredTemplates = discovered.filter((route) => route.includes(":"));

        let enumerated: Record<string, string[]> = {};
        if (discoveredTemplates.length > 0) {
            try {
                const res = await fetch(`${baseUrl}${fetchPrefix}${STATIC_PATHS_ROUTE}`);
                if (res.status === 200) enumerated = await res.json();
            } catch {
                // Enumeration endpoint unreachable or returned something unexpected (e.g. the
                // crawled server wasn't started via runStaticExport(), so it was never active) —
                // every discovered template falls back to being reported in dynamicRoutes below,
                // exactly as if nothing had enumerated it.
            }
        }

        const enumeratedRoutes: string[] = [];
        for (const template of discoveredTemplates) {
            const concretePaths = enumerated[template];
            if (concretePaths && concretePaths.length > 0) {
                enumeratedRoutes.push(...concretePaths);
            } else if (!isExcluded(template)) {
                result.dynamicRoutes.push({ path: outputPrefix + template });
            }
        }

        const routes = [...new Set([...discoveredConcrete, ...enumeratedRoutes, ...(app.paths ?? [])])]
            .filter((route) => !isExcluded(route));
        for (const route of routes) {
            tasks.push({ route, fetchPrefix, outputPrefix });
        }
    }

    // Start from a clean outDir so a page removed from appDir or newly added to `exclude`
    // doesn't leave stale — possibly personalized — HTML behind from a prior export run.
    // Refuse if outDir resolves to cwd, an ancestor of it, or the filesystem root — an
    // `rm -rf` on a misconfigured outDir (e.g. "." or "/") must never be silently possible.
    const resolvedOutDir = path.resolve(outDir);
    const cwd = process.cwd();
    if (
        resolvedOutDir === cwd ||
        cwd.startsWith(resolvedOutDir + path.sep) ||
        resolvedOutDir === path.parse(resolvedOutDir).root
    ) {
        throw new Error(
            `[rapidreact] Refusing to empty outDir "${outDir}" — it resolves to the current working ` +
            `directory, one of its ancestors, or the filesystem root. Use a dedicated subdirectory instead.`
        );
    }
    fs.rmSync(resolvedOutDir, { recursive: true, force: true });
    fs.mkdirSync(resolvedOutDir, { recursive: true });

    await runWithConcurrency(tasks, concurrency, async (task) => {
        const reportedPath = task.outputPrefix + task.route;
        try {
            const res = await fetch(baseUrl + task.fetchPrefix + task.route);
            const html = await res.text();
            if (res.status !== 200) {
                result.errors.push({ path: reportedPath, status: res.status });
                return;
            }
            const outFile = writeRouteHtml(outDir, task.outputPrefix, task.route, html);
            result.pages.push({ path: reportedPath, outFile, status: res.status });
        } catch (err) {
            result.errors.push({ path: reportedPath, error: err instanceof Error ? err.message : String(err) });
        }
    });

    if (notFound) {
        // The first app is authoritative for the site-wide 404 fallback — matches how a static
        // host only ever looks for one root-level 404.html regardless of app count.
        const primaryPrefix = apps[0]?.routePrefix ?? "";
        try {
            const res = await fetch(baseUrl + primaryPrefix + NOT_FOUND_PROBE);
            const html = await res.text();
            if (res.status !== 404) {
                result.errors.push({ path: NOT_FOUND_PROBE, status: res.status });
            } else {
                fs.writeFileSync(path.join(outDir, "404.html"), html);
            }
        } catch (err) {
            result.errors.push({ path: NOT_FOUND_PROBE, error: err instanceof Error ? err.message : String(err) });
        }
    }

    if (fs.existsSync(assetsDir)) {
        fs.cpSync(assetsDir, outDir, { recursive: true });
    }

    return result;
}

/**
 * Convenience wrapper: starts a real `Server` instance, crawls it with `exportStaticSite()`,
 * then stops it. Does not destroy `serverOptions.objectFactory` — the caller created it and
 * owns its lifecycle (call `objectFactory.destroy()` after this resolves), matching the
 * `Server`/`ObjectFactory` ownership split used elsewhere in this codebase.
 *
 * Sets `STATIC_EXPORT_ENV_VAR` for the lifetime of the server it starts, activating each
 * `ReactRoute`'s static-path-enumeration endpoint on it — the server this function boots is
 * always a short-lived, export-only instance, never the app's real deployment, so this is the one
 * place that flag is safe to set. Restored afterward (not just left set) in case the calling
 * process goes on to do other things — e.g. a test suite invoking this repeatedly, or a host
 * embedding export as one step alongside others.
 */
export async function runStaticExport(
    serverOptions: ServerOptions,
    exportOptions: Omit<StaticExportOptions, "port"> = {}
): Promise<StaticExportResult> {
    const server = new Server(serverOptions);
    const originalEnvVar = process.env[STATIC_EXPORT_ENV_VAR];
    process.env[STATIC_EXPORT_ENV_VAR] = "true";
    await server.start();
    try {
        return await exportStaticSite({ port: server.port, ...exportOptions });
    } finally {
        await server.stop();
        if (originalEnvVar === undefined) {
            delete process.env[STATIC_EXPORT_ENV_VAR];
        } else {
            process.env[STATIC_EXPORT_ENV_VAR] = originalEnvVar;
        }
    }
}
