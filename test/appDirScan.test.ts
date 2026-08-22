///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { scanAppDirPages } from "../src/appDirScan.js";

describe("scanAppDirPages", () => {
    it("Returns an empty array when appDir does not exist.", () => {
        expect(scanAppDirPages("test/fixtures/does-not-exist")).toEqual([]);
    });

    it("Returns an empty array when appDir exists but has no matching entries.", () => {
        expect(scanAppDirPages("test/fixtures/vite-empty")).toEqual([]);
    });

    it("Discovers top-level .tsx files, excludes underscore-prefixed files/dirs, includes " +
        "subdirectory index.tsx one level deep, and excludes subdirectories without an index.tsx.", () => {
        const result = scanAppDirPages("test/fixtures/vite-app").sort();
        expect(result).toEqual(["page1.tsx", "sub/index.tsx"]);
    });

    it("Discovers index.tsx at arbitrary nesting depth, excluding non-index files and " +
        "underscore-prefixed directories at any depth.", () => {
        const result = scanAppDirPages("test/fixtures/vite-app-nested");
        expect(result).toEqual(["auth/login/index.tsx"]);
    });

    it("Returns both files, undeduplicated, when a route is served by both a top-level file " +
        "and a nested index.tsx (deduplication is a concern for callers, not the raw scan).", () => {
        const result = scanAppDirPages("test/fixtures/static-dup").sort();
        expect(result).toEqual(["dup.tsx", "dup/index.tsx"]);
    });
});
