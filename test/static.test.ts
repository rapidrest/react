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
import { STATIC_EXPORT_ENV_VAR } from "../src/routeMatch.js";

describe("discoverRoutes", () => {
    it("Returns an empty array for a non-existent appDir.", () => {
        expect(discoverRoutes("test/fixtures/does-not-exist")).toEqual([]);
    });

    it("Discovers page routes including nested index routes and dynamic-segment templates, " +
        "excluding underscore-prefixed pages.", () => {
        const result = discoverRoutes("test/app").sort();
        expect(result).toEqual([
            "/",
            "/auth/login",
            "/di-pets",
            "/pets",
            "/pets/:id",
            "/pets/:id/reviews/:reviewId",
            "/pets/featured",
        ]);
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
        expect(result.pages.map((p) => p.path).sort()).toEqual([
            "/",
            "/auth/login",
            "/di-pets",
            "/pets",
            "/pets/featured",
        ]);
        // The dynamic-segment templates under test/app/pets/ aren't crawlable literal URLs —
        // reported separately instead (see the "exportStaticSite dynamic routes" describe below
        // for dedicated coverage of that split).
        expect(result.dynamicRoutes.map((r) => r.path).sort()).toEqual(["/pets/:id", "/pets/:id/reviews/:reviewId"]);
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
        expect(paths).toEqual(["/", "/di-pets", "/pets/featured"]);
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
        expect(result.pages.length).toBe(5);
    });

    // These two tests opt into "export mode" manually (the env var runStaticExport() would
    // otherwise set) since this describe manages its own long-lived Server directly rather than
    // going through runStaticExport() per test — every other test above deliberately runs WITHOUT
    // it, proving exportStaticSite() still degrades gracefully (falls back to reporting templates
    // in dynamicRoutes) against a server that was never started for export at all, exactly as
    // documented for the "already-running server" use case.
    function withStaticExportMode<T>(fn: () => Promise<T>): Promise<T> {
        const original = process.env[STATIC_EXPORT_ENV_VAR];
        process.env[STATIC_EXPORT_ENV_VAR] = "true";
        return fn().finally(() => {
            if (original === undefined) delete process.env[STATIC_EXPORT_ENV_VAR];
            else process.env[STATIC_EXPORT_ENV_VAR] = original;
        });
    }

    it("Enumerates and crawls a dynamic route's concrete instances when getStaticPaths() is " +
        "available (test/app/pets/[id].tsx's page-level export, backed by the real " +
        "DynamicPetService for props), reporting only the remaining un-enumerated nested " +
        "template.", async () => {
        const result = await withStaticExportMode(() => exportStaticSite({
            port: server.port,
            appDir: "test/app",
            routePrefix: "/app",
            outDir: tmpDir,
            assetsDir: noAssets(),
            notFound: false,
        }));

        expect(result.errors).toEqual([]);
        expect(result.pages.map((p) => p.path).sort()).toEqual([
            "/",
            "/auth/login",
            "/di-pets",
            "/pets",
            "/pets/1",
            "/pets/2",
            "/pets/featured",
        ]);
        expect(result.dynamicRoutes).toEqual([{ path: "/pets/:id/reviews/:reviewId" }]);

        const pet1 = fs.readFileSync(path.join(tmpDir, "pets", "1", "index.html"), "utf-8");
        expect(pet1).toContain("PetId:1");
        expect(pet1).toContain("FromPage:true");
        expect(pet1).toContain("FromService:true");
        expect(pet1).toContain("ServiceSawId:1");
        expect(fs.readFileSync(path.join(tmpDir, "pets", "2", "index.html"), "utf-8")).toContain("PetId:2");
    });

    it("Still excludes an enumerated dynamic route's concrete instances when they match " +
        "exclude, even though they were successfully enumerated.", async () => {
        const result = await withStaticExportMode(() => exportStaticSite({
            port: server.port,
            appDir: "test/app",
            routePrefix: "/app",
            outDir: tmpDir,
            assetsDir: noAssets(),
            notFound: false,
            exclude: [/^\/pets\/\d+$/],
        }));

        const paths = result.pages.map((p) => p.path);
        expect(paths).not.toContain("/pets/1");
        expect(paths).not.toContain("/pets/2");
        expect(paths).toContain("/pets/featured");
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

describe("exportStaticSite dynamic routes", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rapidreact-static-export-dynamic-"));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function mockFetch() {
        return vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any) => {
            if (String(url).includes("__rapidrest_static_export_404_probe__")) {
                return new Response("<html>NotFound</html>", { status: 404 });
            }
            return new Response("<html>Page</html>", { status: 200 });
        });
    }

    it("Crawls only the literal discovered route, reporting the dynamic template separately " +
        "instead of fetching it as a literal (and incorrect) URL.", async () => {
        const fetchSpy = mockFetch();
        try {
            const result = await exportStaticSite({
                port: 1,
                appDir: "test/fixtures/vite-app-dynamic",
                outDir: tmpDir,
                assetsDir: path.join(tmpDir, "__no_assets__"),
                notFound: false,
            });

            expect(result.pages.map((p) => p.path)).toEqual(["/pets/featured"]);
            expect(result.dynamicRoutes).toEqual([{ path: "/pets/:id" }]);
            const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
            expect(urls.some((u) => u.includes(":id"))).toBe(false);
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it("Crawls a dynamic route normally when a concrete instance is supplied via paths, and " +
        "that instance does not itself appear in dynamicRoutes — only the raw template does.", async () => {
        const fetchSpy = mockFetch();
        try {
            const result = await exportStaticSite({
                port: 1,
                appDir: "test/fixtures/vite-app-dynamic",
                outDir: tmpDir,
                assetsDir: path.join(tmpDir, "__no_assets__"),
                notFound: false,
                paths: ["/pets/1"],
            });

            expect(result.pages.map((p) => p.path).sort()).toEqual(["/pets/1", "/pets/featured"]);
            expect(result.dynamicRoutes).toEqual([{ path: "/pets/:id" }]);
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it("Does not report an excluded dynamic template in dynamicRoutes — it was deliberately " +
        "opted out, not merely left unconcretized.", async () => {
        const fetchSpy = mockFetch();
        try {
            const result = await exportStaticSite({
                port: 1,
                appDir: "test/fixtures/vite-app-dynamic",
                outDir: tmpDir,
                assetsDir: path.join(tmpDir, "__no_assets__"),
                notFound: false,
                exclude: ["/pets/:id"],
            });

            expect(result.dynamicRoutes).toEqual([]);
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

describe("exportStaticSite multi-app (apps option)", () => {
    let tmpDir: string;

    // Mocks the crawled server: "/admin/..." routes get "Admin" content, the 404 probe (matched
    // by its literal path, checked first so it isn't shadowed by the "/admin" substring check)
    // returns a real 404, and everything else (the "/" app) gets "WWW" content.
    function mockMultiAppFetch() {
        return vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any) => {
            const u = String(url);
            if (u.includes("__rapidrest_static_export_404_probe__")) {
                return new Response("<html>NotFound</html>", { status: 404 });
            }
            if (u.includes("/admin/")) {
                return new Response("<html>Admin</html>", { status: 200 });
            }
            return new Response("<html>WWW</html>", { status: 200 });
        });
    }

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rapidreact-static-export-multiapp-"));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("Crawls every app, writing each one's pages under its own routePrefix subdirectory.", async () => {
        const fetchSpy = mockMultiAppFetch();
        try {
            const result = await exportStaticSite({
                port: 1,
                outDir: tmpDir,
                assetsDir: path.join(tmpDir, "__no_assets__"),
                notFound: false,
                apps: [
                    { appDir: "test/fixtures/vite-app", routePrefix: "" },
                    { appDir: "test/fixtures/vite-app-nested", routePrefix: "/admin" },
                ],
            });

            expect(result.errors).toEqual([]);
            expect(result.pages.map((p) => p.path).sort()).toEqual([
                "/admin/auth/login",
                "/admin/auth/login/LoginForm",
                "/page1",
                "/sub",
                "/sub2/other",
            ]);

            expect(fs.readFileSync(path.join(tmpDir, "page1", "index.html"), "utf-8")).toContain("WWW");
            expect(fs.readFileSync(path.join(tmpDir, "sub", "index.html"), "utf-8")).toContain("WWW");
            expect(fs.readFileSync(path.join(tmpDir, "admin", "auth", "login", "index.html"), "utf-8"))
                .toContain("Admin");
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it("Fetches each app's routes against its own routePrefix.", async () => {
        const fetchSpy = mockMultiAppFetch();
        try {
            await exportStaticSite({
                port: 1,
                host: "127.0.0.1",
                outDir: tmpDir,
                assetsDir: path.join(tmpDir, "__no_assets__"),
                notFound: false,
                apps: [
                    { appDir: "test/fixtures/vite-app", routePrefix: "" },
                    { appDir: "test/fixtures/vite-app-nested", routePrefix: "/admin" },
                ],
            });

            const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
            expect(urls).toContain("http://127.0.0.1:1/page1");
            expect(urls).toContain("http://127.0.0.1:1/admin/auth/login");
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it("Probes the 404 fallback using the first app's routePrefix.", async () => {
        const fetchSpy = mockMultiAppFetch();
        try {
            await exportStaticSite({
                port: 1,
                outDir: tmpDir,
                assetsDir: path.join(tmpDir, "__no_assets__"),
                notFound: true,
                apps: [
                    { appDir: "test/fixtures/does-not-exist", routePrefix: "/admin" },
                    { appDir: "test/fixtures/does-not-exist", routePrefix: "" },
                ],
            });

            const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
            expect(urls).toContain("http://127.0.0.1:1/admin/__rapidrest_static_export_404_probe__");
            expect(fs.readFileSync(path.join(tmpDir, "404.html"), "utf-8")).toContain("NotFound");
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it("Applies output-prefixing even for a single-entry apps array (opt-in by shape, not length).", async () => {
        const fetchSpy = mockMultiAppFetch();
        try {
            const result = await exportStaticSite({
                port: 1,
                outDir: tmpDir,
                assetsDir: path.join(tmpDir, "__no_assets__"),
                notFound: false,
                apps: [{ appDir: "test/fixtures/vite-app", routePrefix: "/admin" }],
            });

            expect(result.pages.map((p) => p.path).sort()).toEqual([
                "/admin/page1",
                "/admin/sub",
                "/admin/sub2/other",
            ]);
            expect(fs.existsSync(path.join(tmpDir, "admin", "page1", "index.html"))).toBe(true);
            // Confirms this differs from the single-app shorthand, which never prefixes output.
            expect(fs.existsSync(path.join(tmpDir, "page1", "index.html"))).toBe(false);
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it("Defaults an app's routePrefix to \"\" when omitted from an apps entry.", async () => {
        const fetchSpy = mockMultiAppFetch();
        try {
            const result = await exportStaticSite({
                port: 1,
                outDir: tmpDir,
                assetsDir: path.join(tmpDir, "__no_assets__"),
                notFound: true,
                apps: [{ appDir: "test/fixtures/vite-app" }], // routePrefix omitted entirely
            });

            expect(result.pages.map((p) => p.path).sort()).toEqual(["/page1", "/sub", "/sub2/other"]);
            const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
            expect(urls).toContain("http://127.0.0.1:1/__rapidrest_static_export_404_probe__");
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it("Defaults the 404 probe's prefix to \"\" when apps is empty.", async () => {
        const fetchSpy = mockMultiAppFetch();
        try {
            const result = await exportStaticSite({
                port: 1,
                outDir: tmpDir,
                assetsDir: path.join(tmpDir, "__no_assets__"),
                notFound: true,
                apps: [],
            });

            expect(result.pages).toEqual([]);
            const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
            expect(urls).toEqual(["http://127.0.0.1:1/__rapidrest_static_export_404_probe__"]);
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it("Applies each app's own paths and exclude independently.", async () => {
        const fetchSpy = mockMultiAppFetch();
        try {
            const result = await exportStaticSite({
                port: 1,
                outDir: tmpDir,
                assetsDir: path.join(tmpDir, "__no_assets__"),
                notFound: false,
                apps: [
                    { appDir: "test/fixtures/vite-app", routePrefix: "", exclude: ["/page1"], paths: ["/extra"] },
                    { appDir: "test/fixtures/vite-app-nested", routePrefix: "/admin" },
                ],
            });

            const paths = result.pages.map((p) => p.path).sort();
            expect(paths).toEqual([
                "/admin/auth/login",
                "/admin/auth/login/LoginForm",
                "/extra",
                "/sub",
                "/sub2/other",
            ]);
        } finally {
            fetchSpy.mockRestore();
        }
    });
});
