///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { fileToRouteTemplate, scanAppDirPages } from "../src/appDirScan.js";

describe("scanAppDirPages", () => {
    it("Returns an empty array when appDir does not exist.", () => {
        expect(scanAppDirPages("test/fixtures/does-not-exist")).toEqual([]);
    });

    it("Returns an empty array when appDir exists but has no matching entries.", () => {
        expect(scanAppDirPages("test/fixtures/vite-empty")).toEqual([]);
    });

    it("Discovers top-level .tsx files, excludes underscore-prefixed files/dirs, and includes " +
        "nested .tsx files (index or otherwise) at any depth.", () => {
        const result = scanAppDirPages("test/fixtures/vite-app").sort();
        expect(result).toEqual(["page1.tsx", "sub/index.tsx", "sub2/other.tsx"]);
    });

    it("Discovers .tsx files (index or otherwise) at arbitrary nesting depth, excluding " +
        "underscore-prefixed directories at any depth.", () => {
        const result = scanAppDirPages("test/fixtures/vite-app-nested").sort();
        expect(result).toEqual(["auth/login/LoginForm.tsx", "auth/login/index.tsx"]);
    });

    it("Returns both files, undeduplicated, when a route is served by both a top-level file " +
        "and a nested index.tsx (deduplication is a concern for callers, not the raw scan).", () => {
        const result = scanAppDirPages("test/fixtures/static-dup").sort();
        expect(result).toEqual(["dup.tsx", "dup/index.tsx"]);
    });

    it("Discovers a bracketed dynamic-segment leaf file via the same general rule, with no " +
        "special-casing, while an underscore-prefixed directory stays excluded.", () => {
        const result = scanAppDirPages("test/fixtures/vite-app-dynamic").sort();
        expect(result).toEqual(["pets/[id].tsx", "pets/featured.tsx"]);
    });
});

describe("fileToRouteTemplate", () => {
    it("Converts a top-level file to its route.", () => {
        expect(fileToRouteTemplate("pets.tsx")).toBe("/pets");
    });

    it("Converts a top-level index.tsx to the root route.", () => {
        expect(fileToRouteTemplate("index.tsx")).toBe("/");
    });

    it("Converts a nested index.tsx to its directory's route.", () => {
        expect(fileToRouteTemplate("auth/login/index.tsx")).toBe("/auth/login");
    });

    it("Converts a bracketed leaf file to a :name template.", () => {
        expect(fileToRouteTemplate("pets/[id].tsx")).toBe("/pets/:id");
    });

    it("Converts a bracketed directory with an index.tsx to a :name template.", () => {
        expect(fileToRouteTemplate("pets/[id]/index.tsx")).toBe("/pets/:id");
    });

    it("Converts multiple bracketed segments to multiple :name tokens.", () => {
        expect(fileToRouteTemplate("pets/[id]/reviews/[reviewId].tsx")).toBe("/pets/:id/reviews/:reviewId");
    });
});
