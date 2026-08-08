///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import fs from "fs";
import os from "os";
import path from "path";
import config from "./config";
import { request } from "@rapidrest/service-core/test";
import { Server, ObjectFactory, HttpRequest, HttpResponse } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { ReactRoute } from "../src/ReactRoute.js";

// AppRouter is mounted at /app/* — all React pages are served under that prefix.
const UI_BASE = "/app";

function fakeRequest(overrides: Partial<HttpRequest>): HttpRequest {
    return {
        method: "GET",
        path: "/",
        url: "/",
        headers: {},
        params: {},
        query: {},
        body: undefined,
        cookies: {},
        signedCookies: {},
        socket: {},
        ...overrides,
    };
}

// Minimal response double recording status/headers/body — enough for both tryServeAsset()
// (setHeader/send) and the full get() handler (status/setHeader/send). `calls` is a stable
// object reference that callers should read from *after* the call under test completes —
// destructuring its fields upfront would snapshot them before status()/send() ever run.
function fakeResponse(): { res: HttpResponse; calls: { status?: number; headers: Record<string, string>; body: any } } {
    const calls: { status?: number; headers: Record<string, string>; body: any } = { headers: {}, body: undefined };
    const res: any = {
        status(code: number) {
            calls.status = code;
            return res;
        },
        setHeader(key: string, value: string) {
            calls.headers[key] = value;
        },
        send(body: any) {
            calls.body = body;
        },
    };
    return { res, calls };
}

// Exposes protected methods for direct unit testing.
class TestableReactRoute extends ReactRoute {
    public callResolveAppFile(appDir: string, segment: string): Promise<string | null> {
        return this.resolveAppFile(appDir, segment);
    }

    public callHashRequest(req: HttpRequest): string {
        return this.hashRequest(req);
    }

    public callEscapeForInlineScript(json: string): string {
        return this.escapeForInlineScript(json);
    }

    public callPickUserFields(user: any): Record<string, any> | undefined {
        return this.pickUserFields(user);
    }

    public callIsDevMode(): boolean {
        return this.isDevMode();
    }

    public setManifest(manifest: Record<string, { file: string; css?: string[]; name?: string }> | null): void {
        (this as any).manifest = manifest;
    }

    public callResolveClientUrls(pagePath: string): { js: string; css: string[] } {
        return (this as any).resolveClientUrls(pagePath);
    }

    public setManifestPath(manifestPath: string): void {
        (this as any).manifestPath = manifestPath;
    }

    public callTryServeAsset(pageSegment: string, res: HttpResponse): Promise<boolean> {
        return (this as any).tryServeAsset(pageSegment, res);
    }
}

describe("ReactRoute Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server", logger, objectFactory });

    beforeAll(async () => {
        await server.start();
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    it("Can serve the home page from app/index.tsx.", async () => {
        expect(server.isRunning()).toBe(true);
        const result = await request(server.getApplication()).get(UI_BASE + "/");
        expect(result).toBeDefined();
        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body).toBeDefined();
        expect(result.body).toContain("<p>Home</p>");
    });

    it("Serves the home page from the bare /app path (no trailing slash) via getIndex().", async () => {
        const result = await request(server.getApplication()).get(UI_BASE);
        expect(result).toBeDefined();
        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body).toContain("<p>Home</p>");
    });

    it("Wraps pages in _layout.tsx.", async () => {
        const result = await request(server.getApplication()).get(UI_BASE + "/");
        expect(result.body).toMatch(/^<html>/);
        expect(result.body).toContain("<body>");
    });

    it("Calls fetchProps and passes data to the page component.", async () => {
        const result = await request(server.getApplication()).get(UI_BASE + "/pets");
        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body).toContain("<li>Cat</li>");
        expect(result.body).toContain("<li>Dog</li>");
    });

    it("Supports index convention — /auth/login resolves to app/auth/login/index.tsx.", async () => {
        const result = await request(server.getApplication()).get(UI_BASE + "/auth/login");
        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body).toContain("<form>");
        expect(result.body).toContain("Login");
    });

    it("Returns 404 status and renders _404.tsx for missing paths.", async () => {
        const result = await request(server.getApplication()).get(UI_BASE + "/does-not-exist");
        expect(result.status).toBe(404);
        expect(result.body).toContain("Page not found");
    });

    it("Injects dev live-reload script in non-production mode.", async () => {
        const result = await request(server.getApplication()).get(UI_BASE + "/");
        expect(result.body).toContain("__rapidrest__/reload");
    });

    it("DI fetchProps override provides service data to the page component.", async () => {
        const result = await request(server.getApplication()).get(UI_BASE + "/di-pets");
        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body).toContain("<li>Parrot</li>");
        expect(result.body).toContain("<li>Rabbit</li>");
    });

    it("Returns 404 for a path traversal attempt via the HTTP layer and never leaks file contents.", async () => {
        const result = await request(server.getApplication()).get(UI_BASE + "/../../../../src/ReactRoute");
        expect(result.status).toBe(404);
        expect(result.body).not.toContain("export class ReactRoute");
    });

    it("Renders the full error message on a 500 outside of production.", async () => {
        const result = await request(server.getApplication()).get(UI_BASE + "/_throws");
        expect(result.status).toBe(500);
        expect(result.body).toContain("db connection failed at /secret/internal/path");
    });

    it("Redacts the error message on a 500 in production.", async () => {
        const original = process.env.NODE_ENV;
        try {
            process.env.NODE_ENV = "production";
            const result = await request(server.getApplication()).get(UI_BASE + "/_throws");
            expect(result.status).toBe(500);
            expect(result.body).toContain("Internal Server Error");
            expect(result.body).not.toContain("db connection failed");
            expect(result.body).not.toContain("/secret/internal/path");
        } finally {
            process.env.NODE_ENV = original;
        }
    });

    it("Does not expose the dev-reload script or SSE endpoint when NODE_ENV is misconfigured.", async () => {
        // isDevMode() also treats VITEST/JEST_WORKER_ID as dev signals (so tests get dev-reload
        // behavior by default) — clear those too to genuinely simulate a non-dev environment.
        const originalNodeEnv = process.env.NODE_ENV;
        const originalVitest = process.env.VITEST;
        const originalJestWorkerId = process.env.JEST_WORKER_ID;
        try {
            process.env.NODE_ENV = "staging";
            delete process.env.VITEST;
            delete process.env.JEST_WORKER_ID;

            const page = await request(server.getApplication()).get(UI_BASE + "/");
            expect(page.body).not.toContain("__rapidrest__/reload");

            const sse = await request(server.getApplication()).get(UI_BASE + "/__rapidrest__/reload");
            expect(sse.status).toBe(404);
        } finally {
            process.env.NODE_ENV = originalNodeEnv;
            if (originalVitest !== undefined) process.env.VITEST = originalVitest;
            if (originalJestWorkerId !== undefined) process.env.JEST_WORKER_ID = originalJestWorkerId;
        }
    });
});

describe("ReactRoute.resolveAppFile Tests", () => {
    const route = new TestableReactRoute();

    it("Resolves a page file that exists within the app directory.", async () => {
        const result = await route.callResolveAppFile("test/app", "/index");
        expect(result).not.toBeNull();
        expect(result).toMatch(/index\.tsx$/);
    });

    it("Resolves a nested page file using the index convention.", async () => {
        const result = await route.callResolveAppFile("test/app", "/auth/login");
        expect(result).not.toBeNull();
        expect(result).toMatch(/auth[\\/]login[\\/]index\.tsx$/);
    });

    it("Returns null for a segment with no matching file.", async () => {
        const result = await route.callResolveAppFile("test/app", "/does-not-exist");
        expect(result).toBeNull();
    });

    it("Returns null for a path traversal attempt that escapes the app directory.", async () => {
        // Without the containment check this would resolve to the real src/ReactRoute.tsx file.
        const result = await route.callResolveAppFile("test/app", "/../../src/ReactRoute");
        expect(result).toBeNull();
    });

    it("Returns null for a deep path traversal attempt reaching outside the project.", async () => {
        const result = await route.callResolveAppFile("test/app", "/../../../../../../../../etc/passwd");
        expect(result).toBeNull();
    });

    it("Returns null for a traversal attempt that only partially matches the app dir prefix.", async () => {
        // "test/app-evil" should not be treated as being inside "test/app".
        const result = await route.callResolveAppFile("test/app", "/../app-evil/index");
        expect(result).toBeNull();
    });

    it("Still resolves segments that legitimately stay within the app directory after normalization.", async () => {
        const result = await route.callResolveAppFile("test/app", "/../app/index");
        expect(result).not.toBeNull();
        expect(result).toMatch(/index\.tsx$/);
    });
});

describe("ReactRoute.resolveClientUrls Tests", () => {
    // resolveClientUrls() only consults the in-memory `manifest` field (set via setManifest here)
    // when NODE_ENV is "production" — otherwise it re-reads manifestPath from disk on every call.
    function withProductionManifest<T>(route: TestableReactRoute, manifest: Record<string, any>, fn: () => T): T {
        const original = process.env.NODE_ENV;
        process.env.NODE_ENV = "production";
        route.setManifest(manifest);
        // Bypasses DI (no ObjectFactory instantiation here), so @Logger never populated this field.
        const noop = () => undefined;
        (route as any).logger = { warn: noop, debug: noop, error: noop };
        try {
            return fn();
        } finally {
            process.env.NODE_ENV = original;
        }
    }

    it("Resolves an entry via a direct top-level key match.", () => {
        const route = new TestableReactRoute();
        const pagePath = path.resolve(process.cwd(), "test/app/index.tsx");
        const entryKey = path.relative(process.cwd(), pagePath).replace(/\\/g, "/");
        const result = withProductionManifest(route, { [entryKey]: { file: "assets/index-abc123.js" } }, () =>
            route.callResolveClientUrls(pagePath)
        );
        expect(result.js).toBe("/assets/index-abc123.js");
    });

    it("Falls back to matching a manifest entry's `name` field when the top-level key is prefixed " +
        "(e.g. Vite's virtual hydration-module key for createViteConfig() entries).", () => {
        const route = new TestableReactRoute();
        const pagePath = path.resolve(process.cwd(), "test/app/index.tsx");
        const entryKey = path.relative(process.cwd(), pagePath).replace(/\\/g, "/");
        const manifest = {
            [`rapidrest-entry:${entryKey}`]: {
                file: "assets/index-abc123.js",
                name: entryKey,
                src: `rapidrest-entry:${entryKey}`,
                isEntry: true,
            },
        };
        const result = withProductionManifest(route, manifest, () => route.callResolveClientUrls(pagePath));
        expect(result.js).toBe("/assets/index-abc123.js");
    });

    it("Includes css asset paths from the manifest entry when present.", () => {
        const route = new TestableReactRoute();
        const pagePath = path.resolve(process.cwd(), "test/app/index.tsx");
        const entryKey = path.relative(process.cwd(), pagePath).replace(/\\/g, "/");
        const manifest = { [entryKey]: { file: "assets/index-abc123.js", css: ["assets/a.css", "assets/b.css"] } };
        const result = withProductionManifest(route, manifest, () => route.callResolveClientUrls(pagePath));
        expect(result.css).toEqual(["/assets/a.css", "/assets/b.css"]);
    });

    it("Throws when neither the direct key nor any entry's `name` field matches.", () => {
        const route = new TestableReactRoute();
        const pagePath = path.resolve(process.cwd(), "test/app/index.tsx");
        expect(() =>
            withProductionManifest(route, { "some/other/page.tsx": { file: "assets/other.js" } }, () =>
                route.callResolveClientUrls(pagePath)
            )
        ).toThrow(/hydrate=true requires react.manifestPath/);
    });
});

describe("ReactRoute.tryServeAsset Tests", () => {
    let outDir: string;

    beforeAll(() => {
        outDir = fs.mkdtempSync(path.join(os.tmpdir(), "rrst-outdir-"));
        fs.mkdirSync(path.join(outDir, "assets"), { recursive: true });
        fs.writeFileSync(path.join(outDir, "assets", "bundle-abc123.js"), "console.log('hi');");
        fs.writeFileSync(path.join(outDir, "assets", "malicious.exe"), "not a real asset");
    });

    afterAll(() => {
        fs.rmSync(outDir, { recursive: true, force: true });
    });

    it("Returns false without touching the filesystem when manifestPath is unconfigured.", async () => {
        const route = new TestableReactRoute();
        const { res } = fakeResponse();
        expect(await route.callTryServeAsset("/assets/bundle-abc123.js", res)).toBe(false);
    });

    it("Serves a file that exists under the derived outDir (manifestPath's grandparent dir).", async () => {
        const route = new TestableReactRoute();
        route.setManifestPath(path.join(outDir, ".vite", "manifest.json"));
        const { res, calls } = fakeResponse();
        const handled = await route.callTryServeAsset("/assets/bundle-abc123.js", res);
        expect(handled).toBe(true);
        expect(calls.status).toBeUndefined(); // no explicit status call needed — defaults to 200
        expect(calls.headers["content-type"]).toBe("application/javascript");
        expect(calls.body.toString()).toBe("console.log('hi');");
    });

    it("Returns false for a file that does not exist under outDir.", async () => {
        const route = new TestableReactRoute();
        route.setManifestPath(path.join(outDir, ".vite", "manifest.json"));
        const { res } = fakeResponse();
        expect(await route.callTryServeAsset("/assets/does-not-exist.js", res)).toBe(false);
    });

    it("Returns false for a directory (not a file).", async () => {
        const route = new TestableReactRoute();
        route.setManifestPath(path.join(outDir, ".vite", "manifest.json"));
        const { res } = fakeResponse();
        expect(await route.callTryServeAsset("/assets", res)).toBe(false);
    });

    it("Returns false for an extension not on the allow-list, even though the file exists.", async () => {
        const route = new TestableReactRoute();
        route.setManifestPath(path.join(outDir, ".vite", "manifest.json"));
        const { res } = fakeResponse();
        expect(await route.callTryServeAsset("/assets/malicious.exe", res)).toBe(false);
    });

    it("Returns false for a path traversal attempt that escapes outDir.", async () => {
        const route = new TestableReactRoute();
        route.setManifestPath(path.join(outDir, ".vite", "manifest.json"));
        const { res } = fakeResponse();
        expect(await route.callTryServeAsset("/../../../../../../etc/passwd", res)).toBe(false);
    });

    it("get() short-circuits to the asset response, bypassing page resolution entirely.", async () => {
        const route = new TestableReactRoute();
        const noop = () => undefined;
        (route as any).logger = { warn: noop, debug: noop, error: noop };
        route.setManifestPath(path.join(outDir, ".vite", "manifest.json"));
        const { res, calls } = fakeResponse();

        const result = await route.get(fakeRequest({ path: "/assets/bundle-abc123.js" }), res);

        expect(result).toBe(res);
        expect(calls.headers["content-type"]).toBe("application/javascript");
        expect(calls.body.toString()).toBe("console.log('hi');");
    });
});

describe("ReactRoute hydration + _404 interaction", () => {
    // Hydration entries are only generated for real pages (see findPageEntries in vite.ts) —
    // `_404`/`_500` are deliberately excluded. A hydrate-enabled route must therefore render
    // its 404 fallback without attempting hydration, or every miss would throw/500 instead of 404.
    class HydratingRoute extends TestableReactRoute {
        protected readonly appDir = "test/app";
        protected readonly hydrate = true;
    }

    function makeRoute(manifest: Record<string, { file: string; css?: string[]; name?: string }>): HydratingRoute {
        const route = new HydratingRoute();
        const noop = () => undefined;
        (route as any).logger = { warn: noop, debug: noop, error: noop };
        route.setManifest(manifest);
        return route;
    }

    const original = { nodeEnv: process.env.NODE_ENV };
    beforeAll(() => {
        process.env.NODE_ENV = "production"; // resolveManifest() only reads the in-memory manifest in production
    });
    afterAll(() => {
        process.env.NODE_ENV = original.nodeEnv;
    });

    it("Hydrates a genuinely-matched page (200) when its manifest entry is present.", async () => {
        const indexPath = path.resolve(process.cwd(), "test/app/index.tsx");
        const entryKey = path.relative(process.cwd(), indexPath).replace(/\\/g, "/");
        const route = makeRoute({ [entryKey]: { file: "assets/index-abc123.js" } });
        const { res, calls } = fakeResponse();

        const result = await route.get(fakeRequest({ path: "/" }), res);

        expect(calls.status ?? 200).toBeLessThan(300);
        const html = typeof result === "string" ? result : calls.body;
        expect(html).toContain('id="react-root"');
        expect(html).toContain("/assets/index-abc123.js");
    });

    it("Renders _404 without attempting hydration, even though _404 has no manifest entry.", async () => {
        // Only the real page's entry is present — _404 is intentionally absent.
        const indexPath = path.resolve(process.cwd(), "test/app/index.tsx");
        const entryKey = path.relative(process.cwd(), indexPath).replace(/\\/g, "/");
        const route = makeRoute({ [entryKey]: { file: "assets/index-abc123.js" } });
        const { res, calls } = fakeResponse();

        const result = await route.get(fakeRequest({ path: "/does-not-exist" }), res);

        expect(calls.status).toBe(404);
        const html = typeof result === "string" ? result : calls.body;
        expect(html).toContain("Page not found");
        // No hydration root/bundle — only the unrelated dev-reload script (injected via isDevMode(),
        // independent of hydrate) is expected to be present in this environment.
        expect(html).not.toContain('id="react-root"');
        expect(html).not.toContain('id="react-props"');
        expect(html).not.toContain('<script type="module"');
    });
});

describe("ReactRoute.hashRequest Tests", () => {
    const route = new TestableReactRoute();

    it("Produces different hashes for requests differing only in query.", () => {
        const a = route.callHashRequest(fakeRequest({ path: "/search", query: { id: "1" } }));
        const b = route.callHashRequest(fakeRequest({ path: "/search", query: { id: "2" } }));
        expect(a).not.toBe(b);
    });

    it("Produces the same hash regardless of query key order.", () => {
        const a = route.callHashRequest(fakeRequest({ path: "/search", query: { a: "1", b: "2" } }));
        const b = route.callHashRequest(fakeRequest({ path: "/search", query: { b: "2", a: "1" } }));
        expect(a).toBe(b);
    });

    it("Does not throw when query is undefined and matches an empty query.", () => {
        const a = route.callHashRequest(fakeRequest({ path: "/search", query: undefined }));
        const b = route.callHashRequest(fakeRequest({ path: "/search", query: {} }));
        expect(a).toBe(b);
    });
});

describe("ReactRoute.escapeForInlineScript Tests", () => {
    const route = new TestableReactRoute();

    it("Removes every '<' character, subsuming the exact literal '</script>' case.", () => {
        const result = route.callEscapeForInlineScript(JSON.stringify({ x: "</script>" }));
        expect(result.includes("<")).toBe(false);
    });

    it("Blocks the whitespace-variant </script> bypass that a literal-match regex misses.", () => {
        const payload = JSON.stringify({ x: "</script ><script>alert(1)</script>" });
        const result = route.callEscapeForInlineScript(payload);
        expect(result.includes("<")).toBe(false);
    });

    it("Round-trips through JSON.parse without data loss.", () => {
        const obj = { a: "a < b", b: ["</script>", "<img>"] };
        const result = route.callEscapeForInlineScript(JSON.stringify(obj));
        expect(JSON.parse(result)).toEqual(obj);
    });
});

describe("ReactRoute.pickUserFields Tests", () => {
    it("Returns undefined by default (no userFields configured) even when a user is present.", () => {
        const route = new TestableReactRoute();
        const result = route.callPickUserFields({ uid: "1", roles: ["admin"], secret: "x" });
        expect(result).toBeUndefined();
    });

    it("Returns only the allow-listed fields when userFields is configured.", () => {
        class ScopedRoute extends TestableReactRoute {
            protected readonly userFields = ["uid"];
        }
        const route = new ScopedRoute();
        const result = route.callPickUserFields({ uid: "1", roles: ["admin"], secret: "x" });
        expect(result).toEqual({ uid: "1" });
    });

    it("Silently skips an allow-listed field that is not present on the user object.", () => {
        class ScopedRoute extends TestableReactRoute {
            protected readonly userFields = ["uid", "missing"];
        }
        const route = new ScopedRoute();
        const result = route.callPickUserFields({ uid: "1" });
        expect(result).toEqual({ uid: "1" });
    });

    it("Returns undefined when there is no user, regardless of userFields.", () => {
        class ScopedRoute extends TestableReactRoute {
            protected readonly userFields = ["uid"];
        }
        const route = new ScopedRoute();
        expect(route.callPickUserFields(undefined)).toBeUndefined();
    });
});

describe("ReactRoute.isDevMode Tests", () => {
    const route = new TestableReactRoute();
    let originalNodeEnv: string | undefined;
    let originalVitest: string | undefined;
    let originalJestWorkerId: string | undefined;

    beforeEach(() => {
        originalNodeEnv = process.env.NODE_ENV;
        originalVitest = process.env.VITEST;
        originalJestWorkerId = process.env.JEST_WORKER_ID;
    });

    afterEach(() => {
        process.env.NODE_ENV = originalNodeEnv;
        if (originalVitest !== undefined) process.env.VITEST = originalVitest;
        if (originalJestWorkerId !== undefined) process.env.JEST_WORKER_ID = originalJestWorkerId;
    });

    it("Is false for an unset or non-standard NODE_ENV (fail closed).", () => {
        // Also clear VITEST/JEST_WORKER_ID, which isDevMode() treats as independent dev signals
        // (so tests get dev-reload behavior by default) — neither would be set in a real deployment.
        delete process.env.VITEST;
        delete process.env.JEST_WORKER_ID;

        delete process.env.NODE_ENV;
        expect(route.callIsDevMode()).toBe(false);
        process.env.NODE_ENV = "staging";
        expect(route.callIsDevMode()).toBe(false);
    });

    it("Is true for 'development' and 'test'.", () => {
        process.env.NODE_ENV = "development";
        expect(route.callIsDevMode()).toBe(true);
        process.env.NODE_ENV = "test";
        expect(route.callIsDevMode()).toBe(true);
    });

    it("Is true when VITEST is set, regardless of NODE_ENV.", () => {
        process.env.VITEST = "true";
        process.env.NODE_ENV = "staging";
        expect(route.callIsDevMode()).toBe(true);
    });
});
