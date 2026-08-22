///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import fs from "node:fs";
import path from "node:path";

/**
 * Scans `appDir` and returns the appDir-relative, posix-separated paths of every page file
 * matching `ReactRoute.resolveAppFile()`'s page convention:
 *
 * - `app/*.tsx` — top-level files, excluding those starting with `_`
 * - `app/**\/index.tsx` — index files at any depth, excluding `_*` dirs anywhere in the path
 *
 * Non-index `.tsx` files inside subdirectories are sub-components, not pages, and are skipped.
 *
 * Shared by `vite.ts` (build hydration entry points) and `static.ts` (discover static-export
 * routes) so the page-file convention is defined in exactly one place.
 */
export function scanAppDirPages(appDir: string): string[] {
    const result: string[] = [];
    const absRoot = path.resolve(appDir);
    if (!fs.existsSync(absRoot)) return result;

    const walk = (dir: string, isRoot: boolean) => {
        for (const entry of fs.readdirSync(dir)) {
            if (entry.startsWith("_")) continue;
            const fullPath = path.join(dir, entry);
            const stat = fs.statSync(fullPath);

            if (stat.isFile() && entry.endsWith(".tsx")) {
                // Top-level: any .tsx file is a page. Nested: only index.tsx is.
                if (isRoot || entry === "index.tsx") {
                    result.push(path.relative(absRoot, fullPath).replace(/\\/g, "/"));
                }
            } else if (stat.isDirectory()) {
                walk(fullPath, false);
            }
        }
    };

    walk(absRoot, true);
    return result;
}
