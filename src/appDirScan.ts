///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import fs from "node:fs";
import path from "node:path";
import { parseDynamicSegmentName } from "./routeMatch.js";

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
 * `pets/[id].tsx` -> `/pets/:id`, `pets/[id]/index.tsx` -> `/pets/:id`.
 */
export function fileToRouteTemplate(relPath: string): string {
    const noExt = relPath.replace(/\.tsx$/, "");
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
