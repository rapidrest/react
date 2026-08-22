///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import config from "./config";
import { ObjectFactory, Server } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { discoverRoutes, exportStaticSite } from "../src/static.js";

describe("discoverRoutes", () => {
    it("Returns an empty array for a non-existent appDir.", () => {
        expect(discoverRoutes("test/fixtures/does-not-exist")).toEqual([]);
    });

    it("Discovers page routes including nested index routes, excluding underscore-prefixed pages.", () => {
        const result = discoverRoutes("test/app").sort();
        expect(result).toEqual(["/", "/auth/login", "/di-pets", "/pets"]);
    });

    it("Deduplicates a route served by both a top-level file and a nested index.tsx.", () => {
        expect(discoverRoutes("test/fixtures/static-dup")).toEqual(["/dup"]);
    });
});

describe("exportStaticSite against a real server", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server", logger, objectFactory });

    let tmpDir: string;

    beforeAll(async () => {
        await server.start();
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rapidreact-static-export-"));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // A deliberately non-existent path, used whenever a test needs to guarantee the
    // assetsDir-copy branch is skipped without depending on the real repo's build output.
    const noAssets = () => path.join(tmpDir, "__no_assets__");

    it("Exports every discovered page to outDir and writes 404.html by default.", async () => {
        const result = await exportStaticSite({
            port: server.port,
            appDir: "test/app",
            routePrefix: "/app",
            outDir: tmpDir,
            assetsDir: noAssets(),
            notFound: true,
        });

        expect(result.errors).toEqual([]);
        expect(result.pages.map((p) => p.path).sort()).toEqual(["/", "/auth/login", "/di-pets", "/pets"]);
        for (const page of result.pages) {
            expect(page.status).toBe(200);
            expect(fs.existsSync(page.outFile)).toBe(true);
        }

        expect(fs.readFileSync(path.join(tmpDir, "index.html"), "utf-8")).toContain("Home");
        const pets = fs.readFileSync(path.join(tmpDir, "pets", "index.html"), "utf-8");
        expect(pets).toContain("Cat");
        expect(pets).toContain("Dog");
        const diPets = fs.readFileSync(path.join(tmpDir, "di-pets", "index.html"), "utf-8");
        expect(diPets).toContain("Parrot");
        expect(diPets).toContain("Rabbit");
        expect(fs.readFileSync(path.join(tmpDir, "auth", "login", "index.html"), "utf-8")).toContain("Login");

        expect(fs.readFileSync(path.join(tmpDir, "404.html"), "utf-8")).toContain("Page not found");
    });

    it("Writes no 404.html when notFound is false.", async () => {
        await exportStaticSite({
            port: server.port,
            appDir: "test/app",
            routePrefix: "/app",
            outDir: tmpDir,
            assetsDir: noAssets(),
            notFound: false,
        });
        expect(fs.existsSync(path.join(tmpDir, "404.html"))).toBe(false);
    });

    it("Skips excluded routes, matched by string or RegExp.", async () => {
        const result = await exportStaticSite({
            port: server.port,
            appDir: "test/app",
            routePrefix: "/app",
            outDir: tmpDir,
            assetsDir: noAssets(),
            notFound: false,
            exclude: ["/pets", /^\/auth/],
        });

        const paths = result.pages.map((p) => p.path).sort();
        expect(paths).toEqual(["/", "/di-pets"]);
        expect(fs.existsSync(path.join(tmpDir, "pets", "index.html"))).toBe(false);
        expect(fs.existsSync(path.join(tmpDir, "auth", "login", "index.html"))).toBe(false);
    });

    it("Crawls extra explicit paths and records non-200 responses as errors, not thrown.", async () => {
        const result = await exportStaticSite({
            port: server.port,
            appDir: "test/app",
            routePrefix: "/app",
            outDir: tmpDir,
            assetsDir: noAssets(),
            notFound: false,
            paths: ["/_throws"],
        });

        expect(result.errors).toEqual([{ path: "/_throws", status: 500 }]);
        expect(result.pages.some((p) => p.path === "/_throws")).toBe(false);
        expect(fs.existsSync(path.join(tmpDir, "_throws", "index.html"))).toBe(false);
    });

    it("Copies assetsDir verbatim into outDir when it exists.", async () => {
        const result = await exportStaticSite({
            port: server.port,
            appDir: "test/fixtures/does-not-exist",
            routePrefix: "",
            outDir: tmpDir,
            assetsDir: "test/fixtures/static-assets",
            notFound: false,
        });

        expect(result.pages).toEqual([]);
        expect(result.errors).toEqual([]);
        expect(fs.readFileSync(path.join(tmpDir, "app.js"), "utf-8")).toContain("hydrated");
        expect(fs.readFileSync(path.join(tmpDir, ".vite", "manifest.json"), "utf-8")).toContain("{}");
    });

    it("Does nothing when assetsDir does not exist and there is nothing to crawl.", async () => {
        const result = await exportStaticSite({
            port: server.port,
            appDir: "test/fixtures/does-not-exist",
            routePrefix: "",
            outDir: tmpDir,
            assetsDir: noAssets(),
            notFound: false,
        });
        expect(result.pages).toEqual([]);
        expect(result.errors).toEqual([]);
    });

    it("Honors an explicit host and a custom concurrency value.", async () => {
        const result = await exportStaticSite({
            port: server.port,
            host: "127.0.0.1",
            appDir: "test/app",
            routePrefix: "/app",
            outDir: tmpDir,
            assetsDir: noAssets(),
            notFound: false,
            concurrency: 1,
        });
        expect(result.pages.length).toBe(4);
    });
});

describe("exportStaticSite edge cases", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rapidreact-static-export-edge-"));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("Records a network error without throwing when a page fetch fails.", async () => {
        const result = await exportStaticSite({
            port: 1, // nothing listens on port 1 — the fetch is refused immediately
            appDir: "test/fixtures/does-not-exist",
            paths: ["/x"],
            notFound: false,
            outDir: tmpDir,
            assetsDir: path.join(tmpDir, "__no_assets__"),
        });
        expect(result.pages).toEqual([]);
        expect(result.errors).toEqual([{ path: "/x", error: expect.any(String) }]);
    });

    it("Stringifies a non-Error value thrown during crawl or the 404 probe.", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue("boom");
        try {
            const result = await exportStaticSite({
                port: 1,
                appDir: "test/fixtures/does-not-exist",
                paths: ["/x"],
                notFound: true,
                outDir: tmpDir,
                assetsDir: path.join(tmpDir, "__no_assets__"),
            });
            expect(result.errors.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
                { path: "/__rapidrest_static_export_404_probe__", error: "boom" },
                { path: "/x", error: "boom" },
            ]);
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it("Uses the documented default appDir/host/routePrefix/outDir/assetsDir when omitted, " +
        "without touching the real repo's build output.", async () => {
        const realExistsSync = fs.existsSync.bind(fs);
        const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((p: fs.PathLike) => {
            // Guard: the default assetsDir ("dist/public") may genuinely exist in this repo
            // checkout after a real build — force it absent so this test never copies into
            // the real default outDir ("dist/export").
            if (p === "dist/public") return false;
            return realExistsSync(p);
        });
        try {
            const result = await exportStaticSite({ port: 1 }); // closed port; everything else default
            expect(result.pages).toEqual([]); // default appDir "app" does not exist at repo root
            expect(result.errors).toEqual([{ path: "/__rapidrest_static_export_404_probe__", error: expect.any(String) }]);
            expect(existsSpy).toHaveBeenCalledWith("dist/public");
        } finally {
            existsSpy.mockRestore();
        }
    });
});
