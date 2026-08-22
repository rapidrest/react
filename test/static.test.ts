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

    it("Refuses to write outside outDir when a route value attempts path traversal, and " +
        "records it as an error instead of throwing out of exportStaticSite.", async () => {
        const result = await exportStaticSite({
            port: server.port,
            appDir: "test/fixtures/does-not-exist",
            routePrefix: "/app",
            outDir: tmpDir,
            assetsDir: noAssets(),
            notFound: false,
            // Normalized by fetch's own URL parsing into a real, 200-returning request
            // (/app/pets) before it ever reaches the server — but the raw, unnormalized
            // string is still what gets used to build the output file path.
            paths: ["/../app/pets"],
        });

        expect(result.pages).toEqual([]);
        expect(result.errors).toEqual([
            { path: "/../app/pets", error: expect.stringContaining("Refusing to write outside outDir") },
        ]);
        expect(fs.existsSync(path.join(path.dirname(tmpDir), "app", "pets", "index.html"))).toBe(false);
    });

    it("Removes stale output from a prior export run (e.g. a page later excluded).", async () => {
        await exportStaticSite({
            port: server.port,
            appDir: "test/app",
            routePrefix: "/app",
            outDir: tmpDir,
            assetsDir: noAssets(),
            notFound: false,
        });
        expect(fs.existsSync(path.join(tmpDir, "pets", "index.html"))).toBe(true);

        await exportStaticSite({
            port: server.port,
            appDir: "test/app",
            routePrefix: "/app",
            outDir: tmpDir,
            assetsDir: noAssets(),
            notFound: false,
            exclude: ["/pets"],
        });
        expect(fs.existsSync(path.join(tmpDir, "pets", "index.html"))).toBe(false);
        // Everything else from the first run is still present — this isn't a blanket wipe of
        // unrelated state, just a fresh reflection of what the current crawl actually produced.
        expect(fs.existsSync(path.join(tmpDir, "index.html"))).toBe(true);
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
        // exportStaticSite now empties outDir up front, so relying on the real default
        // ("dist/export") without redirecting cwd would delete this repo's actual build
        // output. path.resolve()/path.join(process.cwd(), ...) respect a mocked process.cwd(),
        // so this alone makes the outDir-related absolute-path operations resolve safely
        // under tmpDir instead of the real repo.
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
        // assetsDir's default ("dist/public") is passed to fs.existsSync as a bare relative
        // string, which Node's native fs bindings resolve against the real OS cwd — unlike
        // path.resolve, that does NOT respect the process.cwd() mock above. Force it absent
        // so this test can never find or copy the real repo's build output either.
        const realExistsSync = fs.existsSync.bind(fs);
        const existsSpy = vi.spyOn(fs, "existsSync").mockImplementation((p: fs.PathLike) => {
            if (p === "dist/public") return false;
            return realExistsSync(p);
        });
        try {
            const result = await exportStaticSite({ port: 1 }); // closed port; everything else default
            expect(result.pages).toEqual([]); // default appDir "app" does not exist under the fake cwd
            expect(result.errors).toEqual([{ path: "/__rapidrest_static_export_404_probe__", error: expect.any(String) }]);
            // default outDir "dist/export" was actually created (under the mocked cwd), proving
            // the default value was used, not just accepted as an unused default parameter.
            expect(fs.existsSync(path.join(tmpDir, "dist", "export"))).toBe(true);
            expect(existsSpy).toHaveBeenCalledWith("dist/public");
        } finally {
            existsSpy.mockRestore();
            cwdSpy.mockRestore();
        }
    });

    it("Records the 404 probe as an error, and does not write 404.html, when the probe " +
        "doesn't return 404.", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unexpected", { status: 500 }));
        try {
            const result = await exportStaticSite({
                port: 1,
                appDir: "test/fixtures/does-not-exist",
                paths: [],
                notFound: true,
                outDir: tmpDir,
                assetsDir: path.join(tmpDir, "__no_assets__"),
            });
            expect(result.errors).toEqual([{ path: "/__rapidrest_static_export_404_probe__", status: 500 }]);
            expect(fs.existsSync(path.join(tmpDir, "404.html"))).toBe(false);
        } finally {
            fetchSpy.mockRestore();
        }
    });
});

describe("exportStaticSite outDir safety guard", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rapidreact-outdir-guard-"));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("Refuses to empty outDir when it resolves to the current working directory.", async () => {
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
        try {
            await expect(exportStaticSite({ port: 1, outDir: ".", notFound: false }))
                .rejects.toThrow(/Refusing to empty outDir/);
        } finally {
            cwdSpy.mockRestore();
        }
    });

    it("Refuses to empty outDir when it is an ancestor of the current working directory.", async () => {
        const nested = path.join(tmpDir, "nested");
        fs.mkdirSync(nested, { recursive: true });
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(nested);
        try {
            await expect(exportStaticSite({ port: 1, outDir: tmpDir, notFound: false }))
                .rejects.toThrow(/Refusing to empty outDir/);
        } finally {
            cwdSpy.mockRestore();
        }
    });

    it("Refuses to empty outDir when it resolves to the filesystem root.", async () => {
        const root = path.parse(process.cwd()).root;
        await expect(exportStaticSite({ port: 1, outDir: root, notFound: false }))
            .rejects.toThrow(/Refusing to empty outDir/);
    });
});
