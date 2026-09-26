///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import fs from "node:fs";
import path from "node:path";
import { parseDynamicSegmentName } from "./routeMatch.js";
import { SHELL_FILE_NAME } from "./routerCore.js";

/**
 * Scans `appDir` and returns the appDir-relative, posix-separated paths of every page file
 * matching `ReactRoute.resolveAppFile()`'s page convention:
 *
 * - Any `.tsx` file not starting with `_`, at any depth, is a page (`app/pets.tsx`,
 * `app/pets/featured.tsx`, `app/pets/[id].tsx`, ...).
 * - `index.tsx` inside a directory serves that directory's own route.
 * - `_`-prefixed files/directories, at any depth, are excluded — this is the only way to colocate
 * a non-page component (a shared layout piece, a helper, etc.) under `appDir` without it
 * becoming its own route.
 *
 * Shared by `vite.ts` (build hydration entry points) and `static.ts` (discover static-export
 * routes) so the page-file convention is defined in exactly one place.
 */
export function scanAppDirPages(appDir: string): string[] {
    const result: string[] = [];
    const absRoot = path.resolve(appDir);
    if (!fs.existsSync(absRoot)) return result;

    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir)) {
            if (entry.startsWith("_")) continue;
            const fullPath = path.join(dir, entry);
            const stat = fs.statSync(fullPath);

            if (stat.isFile() && entry.endsWith(".tsx")) {
                result.push(path.relative(absRoot, fullPath).replace(/\\/g, "/"));
            } else if (stat.isDirectory()) {
                walk(fullPath);
            }
        }
    };

    walk(absRoot);
    return result;
}

/**
 * Converts an appDir-relative page file path (as returned by `scanAppDirPages()`) to the
 * `:name`-templated route path it serves, matching `ReactRoute.resolveAppFile()`'s convention:
 * `index.tsx` -> `/`, `pets.tsx` -> `/pets`, `auth/login/index.tsx` -> `/auth/login`,
 * `pets/[id].tsx` -> `/pets/:id`, `pets/[id]/index.tsx` -> `/pets/:id`. A compiled `.js`/`.jsx` file maps the
 * same way as its `.tsx` source.
 */
export function fileToRouteTemplate(relPath: string): string {
    const noExt = relPath.replace(/\.(tsx|jsx|js)$/, "");
    const deIndexed = noExt.replace(/(^|\/)index$/, "");
    const segments = deIndexed
        .split("/")
        .filter(Boolean)
        .map((segment) => {
            const paramName = parseDynamicSegmentName(segment);
            return paramName ? `:${paramName}` : segment;
        });
    return "/" + segments.join("/");
}

/**
 * The absolute path of `appDir`'s shell — `_shell.tsx` (or `_shell/index.tsx`), next to `_layout.tsx` — or `null` when the app has none. Like
 * every `_`-prefixed file it is never a page (see `scanAppDirPages()`); the client build imports it into the app's
 * router entry so that it can be rendered around the page (see `routerEntrySource()`).
 */
export function findAppDirShell(appDir: string): string | null {
    // The same places the server looks for it (`ReactRoute.resolveAppFile()`, in the same order), as far as source goes.
    for (const candidate of [".tsx", "/index.tsx", ".jsx", "/index.jsx"]) {
        const file = path.resolve(appDir, SHELL_FILE_NAME + candidate);
        if (fs.existsSync(file)) return file;
    }
    return null;
}
