///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import fs from "fs";
import os from "os";
import path from "path";
import { vi } from "vitest";
import config from "./config";
import { HttpRequest, HttpResponse, ObjectFactory, RouteDecorators } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { ReactRoute } from "../src/ReactRoute.js";
import { ReactService } from "../src/ReactDecorators.js";

const { Route } = RouteDecorators;

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

function fakeResponse(): HttpResponse & Record<string, any> {
    return {
        statusCode: 200,
        headersSent: false,
        writableEnded: false,
        status: vi.fn(),
        setHeader: vi.fn(),
        getHeader: vi.fn(),
        json: vi.fn(),
        send: vi.fn(),
        end: vi.fn(),
        flushHeaders: vi.fn(),
        write: vi.fn(),
        onAbort: vi.fn(),
    } as any;
}

const noopLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

// Exposes protected/private members for direct unit testing.
class TestableReactRoute extends ReactRoute {
    public callInit(): Promise<void> {
        return (this as any).init();
    }

    public callFetchProps(req: HttpRequest): Promise<any> {
        return (this as any).fetchProps(req);
    }

    public callInjectDevReloadScript(html: string): string {
        return (this as any).injectDevReloadScript(html);
    }

    public callResolveManifest(): Record<string, { file: string; css?: string[]; name?: string }> | null {
        return (this as any).resolveManifest();
    }

    public setManifestPath(p: string): void {
        (this as any).manifestPath = p;
    }

    public setObjectFactory(of: ObjectFactory | undefined): void {
        (this as any).objectFactory = of;
    }

    public setLogger(l: any): void {
        (this as any).logger = l;
    }

    public setCacheClient(c: any): void {
        (this as any).cacheClient = c;
    }

    public setDevReloadConnectionCount(n: number): void {
        (this as any).devReloadConnectionCount = n;
    }

    public getDevReloadConnectionCount(): number {
        return (this as any).devReloadConnectionCount;
    }

    public setRoutePrefix(prefix: string): void {
        (this as any).routePrefix = prefix;
    }

    public callInjectHydrationAssets(html: string, props: any, pagePath: string): string {
        return (this as any).injectHydrationAssets(html, props, pagePath);
    }

    public callResolveAppFile(appDir: string, segment: string): Promise<string | null> {
        return (this as any).resolveAppFile(appDir, segment);
    }

    public getServiceFor(pageSegment: string): any {
        return (this as any).services.get(pageSegment);
    }
}

// React's jsx-dev-runtime picks its dev vs. prod build based on NODE_ENV the first time it is
// imported, and that module is then cached for the rest of the process. If a later test flips
// NODE_ENV to "production" before any page has ever been rendered, that first render permanently
// (and incorrectly) resolves the prod build, which lacks jsxDEV. Rendering once here, up front,
// in non-production mode guarantees the dev build wins the race regardless of file/test order.
beforeAll(async () => {
    const original = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    class WarmupRoute extends TestableReactRoute {
        protected readonly appDir: string = "test/app";
    }
    const route = new WarmupRoute();
    route.setLogger(noopLogger);
    await route.get(fakeRequest({ path: "/" }), fakeResponse());
    process.env.NODE_ENV = original;
});

describe("ReactRoute.init Tests", () => {
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

    it("Loads the Vite manifest once in production when manifestPath is configured.", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rrst-manifest-"));
        const manifestPath = path.join(dir, "manifest.json");
        fs.writeFileSync(manifestPath, JSON.stringify({ "app/index.tsx": { file: "assets/index.js" } }));
        try {
            // isDevMode() also treats VITEST/JEST_WORKER_ID as independent dev signals, so both
            // must be cleared to genuinely exercise the production (non-dev, no fs.watch) path.
            process.env.NODE_ENV = "production";
            delete process.env.VITEST;
            delete process.env.JEST_WORKER_ID;
            const route = new TestableReactRoute();
            route.setLogger(noopLogger);
            route.setManifestPath(manifestPath);
            await route.callInit();
            const manifest = route.callResolveManifest();
            expect(manifest).toEqual({ "app/index.tsx": { file: "assets/index.js" } });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("Logs a warning and leaves the manifest unset when the manifest file is invalid JSON.", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rrst-manifest-bad-"));
        const manifestPath = path.join(dir, "manifest.json");
        fs.writeFileSync(manifestPath, "not valid json{{{");
        try {
            process.env.NODE_ENV = "production";
            delete process.env.VITEST;
            delete process.env.JEST_WORKER_ID;
            const warn = vi.fn();
            const route = new TestableReactRoute();
            route.setLogger({ ...noopLogger, warn });
            route.setManifestPath(manifestPath);
            await route.callInit();
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("Could not load Vite manifest"));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("Watches the manifest file for changes in dev mode and debounces the reload notification.", async () => {
        // fs.watch is mocked (rather than exercising a real OS-level watcher) so the debounced
        // reload can be driven deterministically with fake timers, avoiding real-filesystem
        // watcher flakiness/teardown races.
        let watchCallback: (() => void) | undefined;
        const watchSpy = vi.spyOn(fs, "watch").mockImplementation(((..._args: any[]) => {
            watchCallback = _args[2];
            return { close: vi.fn() } as any;
        }) as any);
        try {
            const manifestPath = path.join(os.tmpdir(), "rrst-watch-fake-manifest.json");
            const route = new TestableReactRoute();
            route.setLogger(noopLogger);
            route.setManifestPath(manifestPath);
            await route.callInit();
            expect(watchSpy).toHaveBeenCalledWith(manifestPath, { persistent: false }, expect.any(Function));
            expect(watchCallback).toBeTypeOf("function");

            // Register a dev-reload SSE listener via the public get() handler.
            const sseRes = fakeResponse();
            await route.get(fakeRequest({ path: "/__rapidrest__/reload" }), sseRes);
            expect(sseRes.write).toHaveBeenCalledWith(": connected\n\n");

            vi.useFakeTimers();
            try {
                // Fire twice in quick succession to exercise the debounce-clear path (the second
                // call must clear the pending timeout from the first before rescheduling).
                watchCallback!();
                watchCallback!();
                vi.advanceTimersByTime(150);
            } finally {
                vi.useRealTimers();
            }

            expect(sseRes.write).toHaveBeenCalledTimes(2);
            expect(sseRes.write).toHaveBeenCalledWith("data: reload\n\n");
        } finally {
            watchSpy.mockRestore();
        }
    });

    it("Does not throw when fs.watch fails synchronously (e.g. manifest path does not exist).", async () => {
        const route = new TestableReactRoute();
        route.setLogger(noopLogger);
        route.setManifestPath(path.join(os.tmpdir(), "rrst-does-not-exist", "manifest.json"));
        await expect(route.callInit()).resolves.toBeUndefined();
    });

    it("Skips registering a react service for a factory-tracked entry that has no prototype.", async () => {
        const logger = Logger();
        const objectFactory = new ObjectFactory(config, logger);
        objectFactory.classes.set("NotAClass", () => undefined);
        const route = new TestableReactRoute();
        route.setLogger(noopLogger);
        route.setObjectFactory(objectFactory);
        await expect(route.callInit()).resolves.toBeUndefined();
    });

    it("Does not map a react service path when newInstance resolves no instance.", async () => {
        @ReactService("/app/svc")
        class SomeService {}
        const newInstance = vi.fn().mockResolvedValue(undefined);
        const fakeObjectFactory = { classes: new Map<string, any>([["SomeService", SomeService]]), newInstance };
        const route = new TestableReactRoute();
        route.setLogger(noopLogger);
        route.setObjectFactory(fakeObjectFactory as any);
        await route.callInit();
        // init() fires the classes scan without awaiting it (fire-and-forget), so wait for the
        // (mocked) newInstance call to actually resolve before asserting on its effect.
        await vi.waitFor(() => expect(newInstance).toHaveBeenCalled());
        expect(route.getServiceFor("/app/svc")).toBeUndefined();
    });

    it("Maps a react service under its raw path when that path does not start with the route prefix.", async () => {
        @ReactService("/other/svc")
        class OtherService {
            async fetchProps() {
                return { fromService: true };
            }
        }
        const instance = new OtherService();
        const newInstance = vi.fn().mockResolvedValue(instance);
        const fakeObjectFactory = { classes: new Map<string, any>([["OtherService", OtherService]]), newInstance };

        @Route("/app/*")
        class PrefixedRoute extends TestableReactRoute {}

        const route = new PrefixedRoute();
        route.setLogger(noopLogger);
        route.setObjectFactory(fakeObjectFactory as any);
        await route.callInit();
        await vi.waitFor(() => expect(route.getServiceFor("/other/svc")).toBe(instance));
    });

    it("Maps a react service to pageSegment '/' when its path is exactly the route prefix.", async () => {
        @ReactService("/app")
        class RootService {
            async fetchProps() {
                return { fromService: true };
            }
        }
        const instance = new RootService();
        const newInstance = vi.fn().mockResolvedValue(instance);
        const fakeObjectFactory = { classes: new Map<string, any>([["RootService", RootService]]), newInstance };

        @Route("/app/*")
        class PrefixedRoute extends TestableReactRoute {}

        const route = new PrefixedRoute();
        route.setLogger(noopLogger);
        route.setObjectFactory(fakeObjectFactory as any);
        await route.callInit();
        await vi.waitFor(() => expect(route.getServiceFor("/")).toBe(instance));
    });
});

describe("ReactRoute.hashRequest cache eviction", () => {
    it("Clears the shared hash cache once it grows past 10000 entries and keeps working.", () => {
        const route = new TestableReactRoute();
        for (let i = 0; i < 10005; i++) {
            (route as any).hashRequest(fakeRequest({ path: `/evict-${i}` }));
        }
        const a = (route as any).hashRequest(fakeRequest({ path: "/after-evict" }));
        const b = (route as any).hashRequest(fakeRequest({ path: "/after-evict" }));
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{32}$/);
    });
});

describe("ReactRoute.fetchProps default", () => {
    it("Returns an empty object when not overridden by a subclass.", async () => {
        const route = new TestableReactRoute();
        await expect(route.callFetchProps(fakeRequest({}))).resolves.toEqual({});
    });
});

describe("ReactRoute.resolveAppFile edge cases", () => {
    it("Falls back to an empty main-entry path when process.argv[1] is unset.", async () => {
        const original = process.argv[1];
        try {
            process.argv[1] = undefined as any;
            const route = new TestableReactRoute();
            // hasTsxContext still ends up true via the VITEST env fallback, so .tsx resolution
            // still succeeds — this only exercises the `process.argv[1] ?? ""` fallback itself.
            const result = await route.callResolveAppFile("test/app", "/index");
            expect(result).toMatch(/index\.tsx$/);
        } finally {
            process.argv[1] = original;
        }
    });

    it("Caches a resolved path in production so a later on-disk change doesn't affect the cached lookup.", async () => {
        const original = process.env.NODE_ENV;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rrst-resolve-cache-"));
        const filePath = path.join(dir, "page.tsx");
        fs.writeFileSync(filePath, "export default function Page() { return null; }");
        try {
            process.env.NODE_ENV = "production";
            const route = new TestableReactRoute();
            const first = await route.callResolveAppFile(dir, "/page");
            expect(first).toMatch(/page\.tsx$/);

            fs.rmSync(filePath);
            const second = await route.callResolveAppFile(dir, "/page");
            expect(second).toBe(first);
        } finally {
            process.env.NODE_ENV = original;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("ReactRoute.get dev-reload SSE endpoint", () => {
    class AppRoute extends TestableReactRoute {
        protected readonly appDir: string = "test/app";
    }

    it("Streams the SSE handshake for a new connection.", async () => {
        const route = new AppRoute();
        route.setLogger(noopLogger);
        const res = fakeResponse();
        await route.get(fakeRequest({ path: "/__rapidrest__/reload" }), res);
        expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/event-stream");
        expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");
        expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Origin", "*");
        expect(res.flushHeaders).toHaveBeenCalled();
        expect(res.write).toHaveBeenCalledWith(": connected\n\n");
        expect(route.getDevReloadConnectionCount()).toBe(1);
    });

    it("Decrements the connection count and detaches the reload listener on abort.", async () => {
        const route = new AppRoute();
        route.setLogger(noopLogger);
        const res = fakeResponse();
        await route.get(fakeRequest({ path: "/__rapidrest__/reload" }), res);
        expect(route.getDevReloadConnectionCount()).toBe(1);

        const onAbortCb = res.onAbort.mock.calls[0][0];
        onAbortCb();
        expect(route.getDevReloadConnectionCount()).toBe(0);
    });

    it("Responds 503 and does not open a stream once at the max connection count.", async () => {
        const route = new AppRoute();
        route.setLogger(noopLogger);
        route.setDevReloadConnectionCount((route as any).maxDevReloadConnections);
        const res = fakeResponse();
        await route.get(fakeRequest({ path: "/__rapidrest__/reload" }), res);
        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.send).toHaveBeenCalledWith("");
        expect(res.setHeader).not.toHaveBeenCalled();
    });

    it("Declines the connection with 501 instead of leaking when the response has no onAbort.", async () => {
        const route = new AppRoute();
        const warn = vi.fn();
        route.setLogger({ ...noopLogger, warn });
        const res = fakeResponse();
        delete (res as any).onAbort;
        await route.get(fakeRequest({ path: "/__rapidrest__/reload" }), res);
        expect(res.status).toHaveBeenCalledWith(501);
        expect(res.send).toHaveBeenCalledWith("");
        expect(res.setHeader).not.toHaveBeenCalled();
        expect(route.getDevReloadConnectionCount()).toBe(0);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("onAbort"));
    });
});

describe("ReactRoute.get production cache", () => {
    class AppRoute extends TestableReactRoute {
        protected readonly appDir: string = "test/app";
    }

    let originalNodeEnv: string | undefined;

    beforeEach(() => {
        originalNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = "production";
    });

    afterEach(() => {
        process.env.NODE_ENV = originalNodeEnv;
    });

    it("Returns the cached response body directly on a cache hit, without rendering.", async () => {
        const route = new AppRoute();
        route.setLogger(noopLogger);
        const get = vi.fn().mockResolvedValue("<html>cached-value</html>");
        route.setCacheClient({ get, setex: vi.fn() });
        const result = await route.get(fakeRequest({ path: "/" }), fakeResponse());
        expect(result).toBe("<html>cached-value</html>");
        expect(get).toHaveBeenCalled();
    });

    it("Renders and writes through to the cache on a cache miss.", async () => {
        const route = new AppRoute();
        route.setLogger(noopLogger);
        const get = vi.fn().mockResolvedValue(undefined);
        const setex = vi.fn();
        route.setCacheClient({ get, setex });
        const result = await route.get(fakeRequest({ path: "/" }), fakeResponse());
        expect(result).toContain("<p>Home</p>");
        expect(setex).toHaveBeenCalledWith(expect.any(String), (route as any).cacheTTL, expect.any(String));
    });

    it("Falls through to rendering (rather than throwing) when the cache read fails.", async () => {
        const route = new AppRoute();
        const warn = vi.fn();
        route.setLogger({ ...noopLogger, warn });
        const get = vi.fn().mockRejectedValue(new Error("redis down"));
        const setex = vi.fn();
        route.setCacheClient({ get, setex });
        const result = await route.get(fakeRequest({ path: "/" }), fakeResponse());
        expect(String(result)).toContain("<p>Home</p>");
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("Cache read failed"), expect.any(Error));
    });

    it("Does not crash the request when the cache write fails.", async () => {
        const route = new AppRoute();
        const warn = vi.fn();
        route.setLogger({ ...noopLogger, warn });
        const get = vi.fn().mockResolvedValue(undefined);
        const setex = vi.fn().mockRejectedValue(new Error("redis down"));
        route.setCacheClient({ get, setex });
        const result = await route.get(fakeRequest({ path: "/" }), fakeResponse());
        expect(String(result)).toContain("<p>Home</p>");
        // The write failure is reported asynchronously (fire-and-forget) — flush microtasks.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("Failed to write cache"), expect.any(Error));
    });

    it("Coalesces concurrent requests for the same cache key into a single render and cache write.", async () => {
        let fetchCount = 0;
        let releaseGate: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            releaseGate = resolve;
        });
        class SlowRoute extends AppRoute {
            protected override async fetchProps(): Promise<any> {
                fetchCount++;
                await gate;
                return {};
            }
        }
        const route = new SlowRoute();
        route.setLogger(noopLogger);
        const get = vi.fn().mockResolvedValue(undefined);
        const setex = vi.fn();
        route.setCacheClient({ get, setex });

        const req = fakeRequest({ path: "/" });
        const p1 = route.get(req, fakeResponse());
        const p2 = route.get(req, fakeResponse());
        // Let both requests reach (and block on) the gate inside fetchProps before releasing it.
        await new Promise((resolve) => setTimeout(resolve, 0));
        releaseGate();
        const [r1, r2] = await Promise.all([p1, p2]);

        expect(fetchCount).toBe(1);
        expect(String(r1)).toContain("<p>Home</p>");
        expect(String(r2)).toContain("<p>Home</p>");
        expect(setex).toHaveBeenCalledTimes(1);
    });
});

describe("ReactRoute.get pageSegment/props edge cases", () => {
    class AppRoute extends TestableReactRoute {
        protected readonly appDir: string = "test/app";
    }

    it("Resolves the pageSegment to '/' when the request path exactly equals the route prefix.", async () => {
        const route = new AppRoute();
        route.setLogger(noopLogger);
        route.setRoutePrefix("/app");
        const result = await route.get(fakeRequest({ path: "/app" }), fakeResponse());
        expect(String(result)).toContain("<p>Home</p>");
    });

    it("Falls back to an empty routeProps object when fetchProps resolves undefined.", async () => {
        class UndefinedPropsRoute extends AppRoute {
            protected override async fetchProps(): Promise<any> {
                return undefined;
            }
        }
        const route = new UndefinedPropsRoute();
        route.setLogger(noopLogger);
        const result = await route.get(fakeRequest({ path: "/" }), fakeResponse());
        expect(String(result)).toContain("<p>Home</p>");
    });

    it("Spreads the picked user fields into props when userFields is configured and req.user is present.", async () => {
        class ScopedUserRoute extends AppRoute {
            protected readonly hydrate: boolean = true;
            protected readonly userFields: string[] | null = ["uid"];
        }
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rrst-user-props-"));
        const manifestPath = path.join(dir, "manifest.json");
        const pagePath = path.resolve(process.cwd(), "test/app/index.tsx");
        const entryKey = path.relative(process.cwd(), pagePath).replace(/\\/g, "/");
        fs.writeFileSync(manifestPath, JSON.stringify({ [entryKey]: { file: "assets/bundle.js" } }));
        try {
            const route = new ScopedUserRoute();
            route.setLogger(noopLogger);
            route.setManifestPath(manifestPath);
            const result = String(
                await route.get(fakeRequest({ path: "/", user: { uid: "u1", secret: "x" } }), fakeResponse()),
            );
            expect(result).toContain('"user":{"uid":"u1"}');
            expect(result).not.toContain("secret");
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("Does not inject the dev-reload script when isDevMode() is false.", async () => {
        const originalNodeEnv = process.env.NODE_ENV;
        const originalVitest = process.env.VITEST;
        const originalJestWorkerId = process.env.JEST_WORKER_ID;
        const originalArgv1 = process.argv[1];
        try {
            process.env.NODE_ENV = "production";
            delete process.env.VITEST;
            delete process.env.JEST_WORKER_ID;
            // resolveAppFile()'s own hasTsxContext check also independently reads VITEST as a
            // dev-tooling signal — clearing it above would otherwise break .tsx resolution too.
            // Give it an alternate, unrelated signal (a .ts-suffixed argv[1]) to keep page
            // resolution working while isolating isDevMode()'s behavior.
            process.argv[1] = "fake-entry.ts";
            const route = new AppRoute();
            route.setLogger(noopLogger);
            const result = String(await route.get(fakeRequest({ path: "/" }), fakeResponse()));
            expect(result).toContain("<p>Home</p>");
            expect(result).not.toContain("__rapidrest__/reload");
        } finally {
            process.env.NODE_ENV = originalNodeEnv;
            if (originalVitest !== undefined) process.env.VITEST = originalVitest;
            if (originalJestWorkerId !== undefined) process.env.JEST_WORKER_ID = originalJestWorkerId;
            process.argv[1] = originalArgv1;
        }
    });
});

describe("ReactRoute.get 500 fallback pages", () => {
    it("Falls back to the hard-coded 500 page when no _500.tsx exists.", async () => {
        class NoFiveHundredRoute extends TestableReactRoute {
            protected readonly appDir: string = "test/app-no500";
        }
        const route = new NoFiveHundredRoute();
        route.setLogger(noopLogger);
        const res = fakeResponse();
        await route.get(fakeRequest({ path: "/" }), res);
        expect(res.status).toHaveBeenCalledWith(500);
        expect((res.send as any).mock.calls[0]?.[0]).toContain("500 Internal Server Error");
    });

    it("Falls back to the hard-coded 500 page when importing _500.tsx itself throws.", async () => {
        class BrokenFiveHundredRoute extends TestableReactRoute {
            protected readonly appDir: string = "test/app-broken500";
        }
        const route = new BrokenFiveHundredRoute();
        route.setLogger(noopLogger);
        const res = fakeResponse();
        await route.get(fakeRequest({ path: "/" }), res);
        expect(res.status).toHaveBeenCalledWith(500);
        expect((res.send as any).mock.calls[0]?.[0]).toContain("500 Internal Server Error");
    });

    it("Renders the _500 page unwrapped when there is no _layout.tsx.", async () => {
        class NoLayoutFiveHundredRoute extends TestableReactRoute {
            protected readonly appDir: string = "test/app-500-nolayout";
        }
        const route = new NoLayoutFiveHundredRoute();
        route.setLogger(noopLogger);
        const res = fakeResponse();
        await route.get(fakeRequest({ path: "/" }), res);
        expect(res.status).toHaveBeenCalledWith(500);
        const body = (res.send as any).mock.calls[0]?.[0];
        expect(body).toContain("Error page, no layout:");
        expect(body).toContain("boom - no layout configured");
        expect(body).not.toContain("<html>");
    });
});

describe("ReactRoute.injectDevReloadScript Tests", () => {
    const route = new TestableReactRoute();

    it("Injects before </body> when present.", () => {
        const result = route.callInjectDevReloadScript("<html><body>hi</body></html>");
        expect(result).toContain("<script>");
        expect(result.indexOf("<script>")).toBeLessThan(result.indexOf("</body>"));
    });

    it("Injects before </html> when there is no </body>.", () => {
        const result = route.callInjectDevReloadScript("<html>hi</html>");
        expect(result).toContain("<script>");
        expect(result.indexOf("<script>")).toBeLessThan(result.indexOf("</html>"));
    });

    it("Appends the script when there is neither </body> nor </html>.", () => {
        const result = route.callInjectDevReloadScript("plain fragment");
        expect(result.startsWith("plain fragment")).toBe(true);
        expect(result).toContain("<script>");
    });
});

describe("ReactRoute.resolveManifest Tests", () => {
    let originalNodeEnv: string | undefined;

    beforeEach(() => {
        originalNodeEnv = process.env.NODE_ENV;
    });

    afterEach(() => {
        process.env.NODE_ENV = originalNodeEnv;
    });

    it("Returns null in dev mode when manifestPath is not configured.", () => {
        delete process.env.NODE_ENV;
        const route = new TestableReactRoute();
        expect(route.callResolveManifest()).toBeNull();
    });

    it("Reads and parses the manifest from disk on every call in dev mode.", () => {
        delete process.env.NODE_ENV;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rrst-resolve-manifest-"));
        const manifestPath = path.join(dir, "manifest.json");
        fs.writeFileSync(manifestPath, JSON.stringify({ a: { file: "a.js" } }));
        try {
            const route = new TestableReactRoute();
            route.setManifestPath(manifestPath);
            expect(route.callResolveManifest()).toEqual({ a: { file: "a.js" } });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("Returns null in dev mode when the manifest file cannot be read or parsed.", () => {
        delete process.env.NODE_ENV;
        const route = new TestableReactRoute();
        route.setManifestPath(path.join(os.tmpdir(), "rrst-definitely-missing-manifest.json"));
        expect(route.callResolveManifest()).toBeNull();
    });
});

describe("ReactRoute.injectHydrationAssets Tests", () => {
    it("Serializes null in place of undefined/null props.", () => {
        delete process.env.NODE_ENV;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rrst-inject-hydrate-"));
        const manifestPath = path.join(dir, "manifest.json");
        const pagePath = path.resolve(process.cwd(), "test/app/index.tsx");
        const entryKey = path.relative(process.cwd(), pagePath).replace(/\\/g, "/");
        fs.writeFileSync(manifestPath, JSON.stringify({ [entryKey]: { file: "assets/bundle.js" } }));
        try {
            const route = new TestableReactRoute();
            route.setLogger(noopLogger);
            route.setManifestPath(manifestPath);
            const result = route.callInjectHydrationAssets("<body></body>", undefined, pagePath);
            expect(result).toContain('id="react-props">null</script>');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("ReactRoute.get hydration Tests", () => {
    class HydrateRoute extends TestableReactRoute {
        protected readonly appDir: string = "test/app";
        protected readonly hydrate: boolean = true;
    }

    let originalNodeEnv: string | undefined;

    beforeEach(() => {
        originalNodeEnv = process.env.NODE_ENV;
        delete process.env.NODE_ENV;
    });

    afterEach(() => {
        process.env.NODE_ENV = originalNodeEnv;
    });

    it("Injects the hydration root, serialized props, css links, and bundle script.", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rrst-hydrate-"));
        const manifestPath = path.join(dir, "manifest.json");
        const pagePath = path.resolve(process.cwd(), "test/app/index.tsx");
        const entryKey = path.relative(process.cwd(), pagePath).replace(/\\/g, "/");
        fs.writeFileSync(
            manifestPath,
            JSON.stringify({ [entryKey]: { file: "assets/index-abc.js", css: ["assets/index-abc.css"] } }),
        );
        try {
            const route = new HydrateRoute();
            route.setLogger(noopLogger);
            route.setManifestPath(manifestPath);
            const result = await route.get(fakeRequest({ path: "/" }), fakeResponse());
            expect(String(result)).toContain('id="react-root"');
            expect(String(result)).toContain('<script type="application/json" id="react-props">');
            expect(String(result)).toContain('<link rel="stylesheet" href="/assets/index-abc.css">');
            expect(String(result)).toContain('<script type="module" src="/assets/index-abc.js"></script>');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("Falls back to the 500 page when hydrate=true but no manifest is configured.", async () => {
        const route = new HydrateRoute();
        route.setLogger(noopLogger);
        const res = fakeResponse();
        await route.get(fakeRequest({ path: "/" }), res);
        expect(res.status).toHaveBeenCalledWith(500);
    });

    function writeManifestFor(appDir: string): { dir: string; manifestPath: string } {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rrst-hydrate-fallback-"));
        const manifestPath = path.join(dir, "manifest.json");
        const pagePath = path.resolve(process.cwd(), appDir, "index.tsx");
        const entryKey = path.relative(process.cwd(), pagePath).replace(/\\/g, "/");
        fs.writeFileSync(manifestPath, JSON.stringify({ [entryKey]: { file: "assets/bundle.js" } }));
        return { dir, manifestPath };
    }

    it("Appends the hydration payload before </html> when the page has no </body>.", async () => {
        class NoBodyRoute extends TestableReactRoute {
            protected readonly appDir: string = "test/app-hydrate-nobody";
            protected readonly hydrate: boolean = true;
        }
        const { dir, manifestPath } = writeManifestFor("test/app-hydrate-nobody");
        try {
            const route = new NoBodyRoute();
            route.setLogger(noopLogger);
            route.setManifestPath(manifestPath);
            const result = String(await route.get(fakeRequest({ path: "/" }), fakeResponse()));
            expect(result).toContain("NoBody");
            expect(result).toContain('<script type="module" src="/assets/bundle.js"></script>');
            // No </body> anywhere in the page, so both the hydration bundle and the dev-reload
            // script must have been injected before the (only) </html> closing tag, not appended
            // after it.
            expect(result.indexOf('<script type="module" src="/assets/bundle.js">')).toBeLessThan(
                result.indexOf("</html>"),
            );
            expect(result.endsWith("</html></div>")).toBe(true);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("Appends the hydration payload at the end when the page has neither </body> nor </html>.", async () => {
        class PlainRoute extends TestableReactRoute {
            protected readonly appDir: string = "test/app-hydrate-plain";
            protected readonly hydrate: boolean = true;
        }
        const { dir, manifestPath } = writeManifestFor("test/app-hydrate-plain");
        try {
            const route = new PlainRoute();
            route.setLogger(noopLogger);
            route.setManifestPath(manifestPath);
            const result = String(await route.get(fakeRequest({ path: "/" }), fakeResponse()));
            expect(result.startsWith('<div id="react-root"><span>Plain</span></div>')).toBe(true);
            expect(result).toContain('<script type="module" src="/assets/bundle.js"></script>');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
