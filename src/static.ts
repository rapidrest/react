///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import fs from "node:fs";
import path from "node:path";
import { Server, type ServerOptions } from "@rapidrest/service-core";
import { scanAppDirPages } from "./appDirScan.js";

/** A guaranteed-unmatched path used to probe the app's real `_404` page during export. */
const NOT_FOUND_PROBE = "/__rapidrest_static_export_404_probe__";

export interface StaticExportOptions {
    /** Port of the already-running server to crawl. */
    port: number;
    /** Host of the already-running server to crawl. Default `"127.0.0.1"`. */
    host?: string;
    /** Filesystem path to the app directory, relative to cwd. Default `"app"`. */
    appDir?: string;
    /** URL prefix the React route is mounted at (e.g. `"/app"`). Prepended only to the
     * fetch URL — discovered/explicit route paths are always prefix-free. Default `""`. */
    routePrefix?: string;
    /** Directory to write the exported static site to. Default `"dist/export"`. */
    outDir?: string;
    /** Directory of built hydration/static assets, copied verbatim into `outDir`.
     * Default `"dist/public"`. */
    assetsDir?: string;
    /** Extra prefix-free route paths to crawl, beyond what `appDir` convention discovers. */
    paths?: string[];
    /** Route paths to skip (e.g. auth-gated/personalized pages that shouldn't be baked
     * into a public static export). Matched against the prefix-free route path. */
    exclude?: (string | RegExp)[];
    /** Probe and write the app's real `_404` page to `<outDir>/404.html`. Default `true`. */
    notFound?: boolean;
    /** Maximum number of pages to crawl concurrently. Default `5`. */
    concurrency?: number;
}

export interface StaticExportResult {
    pages: { path: string; outFile: string; status: number }[];
    errors: { path: string; status?: number; error?: string }[];
}

/**
 * Converts an appDir-relative page file path (as returned by `scanAppDirPages()`) to the
 * route path it serves, matching `ReactRoute.resolveAppFile()`'s convention:
 * `index.tsx` → `/`, `pets.tsx` → `/pets`, `auth/login/index.tsx` → `/auth/login`.
 */
function fileToRoute(relPath: string): string {
    const noExt = relPath.replace(/\.tsx$/, "");
    return "/" + noExt.replace(/(^|\/)index$/, "");
}

/**
 * Discovers the route paths served by `appDir`, matching the same file convention
 * `vite.ts` uses to discover hydration entry points.
 *
 * `app/pets.tsx` and `app/pets/index.tsx` both legitimately serve `/pets` (per
 * `ReactRoute.resolveAppFile()`'s own suffix-trial order) — when both exist, they map to
 * the same route path here and are deduplicated. Which underlying file backs a route is
 * irrelevant to discovery itself: the live server (crawled over real HTTP by
 * `exportStaticSite()`) is the one that resolves the file for each request, exactly as it
 * would for a normal, non-exported deployment.
 */
export function discoverRoutes(appDir: string): string[] {
    return [...new Set(scanAppDirPages(appDir).map(fileToRoute))];
}

/**
 * Writes `html` to the output file for `route`, creating parent directories as needed.
 * Refuses to write outside `outDir` — `route` may originate from caller-supplied
 * `StaticExportOptions.paths`, so it's untrusted the same way a URL segment is, and gets the
 * same containment check `ReactRoute.resolveAppFile()`/`tryServeAsset()` apply to theirs.
 */
function writeRouteHtml(outDir: string, route: string, html: string): string {
    const root = path.resolve(outDir);
    const outFile = path.resolve(path.join(outDir, route, "index.html"));
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
 */
export async function exportStaticSite(options: StaticExportOptions): Promise<StaticExportResult> {
    const {
        port,
        host = "127.0.0.1",
        appDir = "app",
        routePrefix = "",
        outDir = "dist/export",
        assetsDir = "dist/public",
        paths = [],
        exclude = [],
        notFound = true,
        concurrency = 5,
    } = options;

    const isExcluded = (route: string) =>
        exclude.some((pattern) => (typeof pattern === "string" ? pattern === route : pattern.test(route)));

    const routes = [...new Set([...discoverRoutes(appDir), ...paths])].filter((route) => !isExcluded(route));

    const baseUrl = `http://${host}:${port}`;
    const result: StaticExportResult = { pages: [], errors: [] };

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

    await runWithConcurrency(routes, concurrency, async (route) => {
        try {
            const res = await fetch(baseUrl + routePrefix + route);
            const html = await res.text();
            if (res.status !== 200) {
                result.errors.push({ path: route, status: res.status });
                return;
            }
            const outFile = writeRouteHtml(outDir, route, html);
            result.pages.push({ path: route, outFile, status: res.status });
        } catch (err) {
            result.errors.push({ path: route, error: err instanceof Error ? err.message : String(err) });
        }
    });

    if (notFound) {
        try {
            const res = await fetch(baseUrl + routePrefix + NOT_FOUND_PROBE);
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
 */
export async function runStaticExport(
    serverOptions: ServerOptions,
    exportOptions: Omit<StaticExportOptions, "port"> = {}
): Promise<StaticExportResult> {
    const server = new Server(serverOptions);
    await server.start();
    try {
        return await exportStaticSite({ port: server.port, ...exportOptions });
    } finally {
        await server.stop();
    }
}
