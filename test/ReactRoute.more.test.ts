///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { vi } from "vitest";
import config from "./config";
import { HttpRequest, HttpResponse, ObjectFactory, RouteDecorators } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { ReactRoute } from "../src/ReactRoute.js";
import { ReactService } from "../src/ReactDecorators.js";
import { STATIC_EXPORT_ENV_VAR, STATIC_PATHS_ROUTE } from "../src/routeMatch.js";

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
        (this as any).cache = c;
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

    public callResolveAppFile(
        appDir: string,
        segment: string,
        internal?: boolean
    ): Promise<{ file: string; params: Record<string, string>; template: string } | null> {
        return (this as any).resolveAppFile(appDir, segment, internal);
    }

    public getServiceFor(pageSegment: string): any {
        return (this as any).services.get(pageSegment);
    }

    public callResolveService(pageSegment: string): any {
        return (this as any).resolveService(pageSegment);
    }

    /** Registers services the way init() does: by their path's template, `:name` tokens by position. */
    public setDynamicServices(services: { template: string; instance: any }[]): void {
        for (const { template, instance } of services) {
            const key = "/" + template.split("/").filter(Boolean).map((part) => (part.startsWith(":") ? ":" : part)).join("/");
            (this as any).services.set(key, instance);
        }
    }

    public callHandleStaticPaths(res: HttpResponse): Promise<void> {
        return (this as any).handleStaticPaths(res);
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

/** A stand-in for `fs.FSWatcher`: a real EventEmitter, so an unhandled 'error' throws, as it does for the real one. */
function fakeWatcher(): any {
    const watcher: any = new EventEmitter();
    watcher.close = vi.fn();
    return watcher;
}

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
            return fakeWatcher();
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

    describe("when a build replaces the manifest the dev server is watching", () => {
        const manifestPath = path.join(os.tmpdir(), "rrst-watch-replaced-manifest.json");

        /** Starts a route watching the manifest with `fs.watch` faked, and an SSE client listening for reloads. */
        async function startWatching(watch: (...args: any[]) => any) {
            const watchSpy = vi.spyOn(fs, "watch").mockImplementation(watch as any);
            const route = new TestableReactRoute();
            route.setLogger(noopLogger);
            route.setManifestPath(manifestPath);
            await route.callInit();
            const sseRes = fakeResponse();
            await route.get(fakeRequest({ path: "/__rapidrest__/reload" }), sseRes);
            const reloads = () =>
                sseRes.write.mock.calls.filter(([chunk]: [string]) => chunk === "data: reload\n\n").length;
            return { watchSpy, reloads };
        }

        afterEach(() => {
            vi.restoreAllMocks();
            vi.useRealTimers();
        });

        it("survives the watcher's error event instead of crashing the process, and watches the new file", async () => {
            // On Windows the watcher emits an 'error' (EPERM) when the file is deleted and recreated. An EventEmitter
            // with no 'error' listener throws when it emits one, which, uncaught, is what killed the dev server.
            const watchers: any[] = [];
            const { watchSpy, reloads } = await startWatching(() => {
                const w = fakeWatcher();
                watchers.push(w);
                return w;
            });
            expect(watchSpy).toHaveBeenCalledTimes(1);
            expect(watchers[0].listenerCount("error")).toBe(1);

            vi.useFakeTimers();
            const err = Object.assign(new Error("EPERM: operation not permitted, watch"), { code: "EPERM" });
            expect(() => watchers[0].emit("error", err)).not.toThrow();
            vi.advanceTimersByTime(150);

            expect(watchers[0].close).toHaveBeenCalled();
            expect(watchSpy).toHaveBeenCalledTimes(2);
            expect(watchSpy).toHaveBeenLastCalledWith(manifestPath, { persistent: false }, expect.any(Function));
            // The build that replaced the manifest has finished, so the browsers are told.
            expect(reloads()).toBe(1);
        });

        it("keeps working after any number of rebuilds", async () => {
            const watchers: any[] = [];
            await startWatching(() => {
                const w = fakeWatcher();
                watchers.push(w);
                return w;
            });

            for (let i = 0; i < 3; i++) {
                expect(() => watchers[i].emit("error", new Error("EPERM"))).not.toThrow();
            }

            expect(watchers).toHaveLength(4);
            expect(watchers[3].listenerCount("error")).toBe(1);
        });

        it("watches the new file when the old one was replaced (a rename), but not for a plain change", async () => {
            const callbacks: Array<(event?: string) => void> = [];
            const watchers: any[] = [];
            const { watchSpy, reloads } = await startWatching(
                (_path: string, _opts: any, cb: (event?: string) => void) => {
                    callbacks.push(cb);
                    const w = fakeWatcher();
                    watchers.push(w);
                    return w;
                },
            );
            vi.useFakeTimers();

            callbacks[0]("change");
            vi.advanceTimersByTime(150);
            expect(watchSpy).toHaveBeenCalledTimes(1);
            expect(watchers[0].close).not.toHaveBeenCalled();
            expect(reloads()).toBe(1);

            callbacks[0]("rename");
            vi.advanceTimersByTime(150);
            expect(watchers[0].close).toHaveBeenCalled();
            expect(watchSpy).toHaveBeenCalledTimes(2);
            // One more reload for the rename and the successful re-watch together, not two.
            expect(reloads()).toBe(2);
        });

        it("keeps looking for a manifest the build hasn't put back yet, then reloads once it's there", async () => {
            let calls = 0;
            const watchers: any[] = [];
            const { watchSpy, reloads } = await startWatching(() => {
                calls++;
                // The first watch works; then the file is missing for the next 3 tries; then it's back.
                if (calls >= 2 && calls <= 4) {
                    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
                }
                const w = fakeWatcher();
                watchers.push(w);
                return w;
            });
            vi.useFakeTimers();

            watchers[0].emit("error", new Error("EPERM"));
            expect(watchSpy).toHaveBeenCalledTimes(2);
            vi.advanceTimersByTime(200 * 3);
            expect(watchSpy).toHaveBeenCalledTimes(5);
            vi.advanceTimersByTime(150);

            expect(watchers).toHaveLength(2);
            expect(reloads()).toBe(1);
            // Found it, so it stops looking.
            vi.advanceTimersByTime(200 * 5);
            expect(watchSpy).toHaveBeenCalledTimes(5);
        });

        it("gives up after a while if the manifest never comes back, without throwing", async () => {
            let calls = 0;
            const watchers: any[] = [];
            const { watchSpy, reloads } = await startWatching(() => {
                calls++;
                if (calls >= 2) {
                    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
                }
                const w = fakeWatcher();
                watchers.push(w);
                return w;
            });
            vi.useFakeTimers();

            watchers[0].emit("error", new Error("EPERM"));
            vi.advanceTimersByTime(200 * 300);

            // The original watch, plus 150 attempts (thirty seconds) to find the replacement, and no more.
            expect(watchSpy).toHaveBeenCalledTimes(151);
            expect(reloads()).toBe(0);
        });

        it("keeps looking at startup for a manifest the first build hasn't written yet, and reloads once it's there", async () => {
            vi.useFakeTimers();
            let calls = 0;
            const { watchSpy, reloads } = await startWatching(() => {
                calls++;
                // The server starts alongside the build: the manifest isn't there for the first 3 tries.
                if (calls <= 3) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
                return fakeWatcher();
            });

            // The try at startup, and the one straight after it that starts the looking.
            expect(watchSpy).toHaveBeenCalledTimes(2);
            vi.advanceTimersByTime(200);
            expect(watchSpy).toHaveBeenCalledTimes(3);
            expect(reloads()).toBe(0);
            vi.advanceTimersByTime(200);
            expect(watchSpy).toHaveBeenCalledTimes(4);
            vi.advanceTimersByTime(150);
            expect(reloads()).toBe(1);
            // Found it, so it stops looking.
            vi.advanceTimersByTime(200 * 5);
            expect(watchSpy).toHaveBeenCalledTimes(4);
        });
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

    it("Finds a page's react service by the page's route template, however the paths are written.", async () => {
        @ReactService("/svc/page")
        class PageService {}
        @ReactService("/svc/trailing/")
        class TrailingService {}
        @ReactService("/svc/things/:thingId")
        class ThingService {}
        const pageInstance = new PageService();
        const trailingInstance = new TrailingService();
        const thingInstance = new ThingService();
        const instances = new Map<any, any>([[PageService, pageInstance], [TrailingService, trailingInstance], [ThingService, thingInstance]]);
        const newInstance = vi.fn(async (clazz: any) => instances.get(clazz));
        const route = new TestableReactRoute();
        route.setLogger(noopLogger);
        route.setObjectFactory({
            classes: new Map<string, any>([["PageService", PageService], ["TrailingService", TrailingService], ["ThingService", ThingService]]),
            newInstance,
        } as any);
        await route.callInit();
        const find = (template: string) => (route as any).resolveService(template);

        expect(find("/svc/page")).toBe(pageInstance);
        expect(find("/svc/page/")).toBe(pageInstance);
        expect(find("/svc/trailing")).toBe(trailingInstance);
        // A `:name` is by position: the page's bracket may be called something else.
        expect(find("/svc/things/:id")).toBe(thingInstance);
        expect(find("/svc/things/:thingId")).toBe(thingInstance);
        expect(find("/svc")).toBeUndefined();
        expect(find("/svc/things/7")).toBeUndefined();
        // No page, no service: the template of a request that matched none is empty, and isn't the root's.
        expect(find("")).toBeUndefined();
    });

    it("Waits for react services to be instantiated before init() resolves.", async () => {
        @ReactService("/app/slow")
        class SlowService {}
        const instance = new SlowService();
        const newInstance = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(instance), 20)));
        const route = new TestableReactRoute();
        route.setLogger(noopLogger);
        route.setObjectFactory({ classes: new Map<string, any>([["SlowService", SlowService]]), newInstance } as any);
        await route.callInit();
        expect(route.getServiceFor("/app/slow")).toBe(instance);
    });

    it("Leaves a react service to the route it belongs to: one whose path isn't under this route's prefix isn't mapped.", async () => {
        @ReactService(["/other/svc", "/", "/apple", "/app/svc"])
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

        // Only "/app/svc" is under "/app" — "/apple" merely starts with the same letters.
        expect(route.getServiceFor("/svc")).toBe(instance);
        for (const other of ["/other/svc", "/", "/apple", "/le", "/app/svc"]) {
            expect(route.getServiceFor(other), other).toBeUndefined();
        }
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

    it("Registers a react service whose path contains a ':name' token under its template, for the page with that route.", async () => {
        @ReactService("/app/pets/:id")
        class DynamicService {
            async fetchProps() {
                return { fromService: true };
            }
        }
        const instance = new DynamicService();
        const newInstance = vi.fn().mockResolvedValue(instance);
        const fakeObjectFactory = { classes: new Map<string, any>([["DynamicService", DynamicService]]), newInstance };

        @Route("/app/*")
        class PrefixedRoute extends TestableReactRoute {}

        const route = new PrefixedRoute();
        route.setLogger(noopLogger);
        route.setObjectFactory(fakeObjectFactory as any);
        await route.callInit();
        expect(route.getServiceFor("/pets/:")).toBe(instance);
        expect(route.callResolveService("/pets/:id")).toBe(instance);
        expect(route.callResolveService("/pets/:petId")).toBe(instance);
        // Not found by what a URL captured: a value that matches the template is not its page.
        expect(route.callResolveService("/pets/99")).toBeUndefined();
        expect(route.callResolveService("/other")).toBeUndefined();
    });

    it("Keeps a literal page's service and its dynamic sibling's apart.", async () => {
        @ReactService("/app/pets/:id")
        class DynamicService {}
        @ReactService("/app/pets/featured")
        class ExactService {}
        const dynamicInstance = new DynamicService();
        const exactInstance = new ExactService();
        const newInstance = vi.fn(async (clazz: any) => (clazz === DynamicService ? dynamicInstance : exactInstance));
        const fakeObjectFactory = {
            classes: new Map<string, any>([
                ["DynamicService", DynamicService],
                ["ExactService", ExactService],
            ]),
            newInstance,
        };

        @Route("/app/*")
        class PrefixedRoute extends TestableReactRoute {}

        const route = new PrefixedRoute();
        route.setLogger(noopLogger);
        route.setObjectFactory(fakeObjectFactory as any);
        await route.callInit();
        expect(route.callResolveService("/pets/featured")).toBe(exactInstance);
        expect(route.callResolveService("/pets/:id")).toBe(dynamicInstance);
    });

    it("Registers services in the order the classes were listed, not the order they finished instantiating in.", async () => {
        @ReactService("/app/dup")
        class First {}
        @ReactService("/app/dup")
        class Second {}
        const firstInstance = new First();
        const secondInstance = new Second();
        // The first class is the slow one to instantiate.
        const newInstance = vi.fn((clazz: any) =>
            clazz === First
                ? new Promise((resolve) => setTimeout(() => resolve(firstInstance), 30))
                : Promise.resolve(secondInstance),
        );

        @Route("/app/*")
        class PrefixedRoute extends TestableReactRoute {}

        const route = new PrefixedRoute();
        route.setLogger(noopLogger);
        route.setObjectFactory({ classes: new Map<string, any>([["First", First], ["Second", Second]]), newInstance } as any);
        await route.callInit();
        // Both claim the page; the one listed last wins, as it always did — whichever finished first.
        expect(route.getServiceFor("/dup")).toBe(secondInstance);
    });
});

describe("ReactRoute.hashRequest", () => {
    it("Is stable for the same request, and a 32-character MD5 digest.", () => {
        const route = new TestableReactRoute();
        const a = (route as any).hashRequest(fakeRequest({ path: "/x" }));
        const b = (route as any).hashRequest(fakeRequest({ path: "/x" }));
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{32}$/);
    });

    it("Tells apart the same request to different apps, so two apps sharing one cache can't answer for each other.", () => {
        class Other extends TestableReactRoute {
            protected readonly appDir = "test/another-app";
        }
        const req = fakeRequest({ path: "/x" });
        expect((new TestableReactRoute() as any).hashRequest(req)).not.toBe((new Other() as any).hashRequest(req));

        @Route("/mount/*")
        class Mounted extends TestableReactRoute {}
        const mounted = new Mounted();
        (mounted as any).routePrefix = "/mount";
        expect((mounted as any).hashRequest(req)).not.toBe((new TestableReactRoute() as any).hashRequest(req));
    });

    it("Under the router, also tells apart the query as written, since the page renders the location it was asked for.", () => {
        class RoutedRoute extends TestableReactRoute {
            protected readonly router = true;
        }
        const routed: any = new RoutedRoute();
        const plain: any = new TestableReactRoute();
        const a = fakeRequest({ path: "/x", url: "/x?a=1&b=2", query: { a: "1", b: "2" } });
        const b = fakeRequest({ path: "/x", url: "/x?b=2&a=1", query: { b: "2", a: "1" } });
        expect(routed.hashRequest(a)).not.toBe(routed.hashRequest(b));
        // ...where nothing renders it, the order needn't matter.
        expect(plain.hashRequest(a)).toBe(plain.hashRequest(b));
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
            expect(result?.file).toMatch(/index\.tsx$/);
        } finally {
            process.argv[1] = original;
        }
    });

    it("Remembers the framework's own _layout/_404/_500 lookups in production, and nothing a URL asked for.", async () => {
        const original = process.env.NODE_ENV;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rrst-resolve-cache-"));
        fs.writeFileSync(path.join(dir, "_404.tsx"), "export default function Page() { return null; }");
        fs.writeFileSync(path.join(dir, "page.tsx"), "export default function Page() { return null; }");
        try {
            process.env.NODE_ENV = "production";
            const route = new TestableReactRoute();
            const first = await route.callResolveAppFile(dir, "_404", true);
            expect(first?.file).toMatch(/_404\.tsx$/);
            const page = await route.callResolveAppFile(dir, "/page");
            expect(page?.file).toMatch(/page\.tsx$/);
            expect((route as any).resolvedFileCache.size).toBe(1);

            fs.rmSync(path.join(dir, "_404.tsx"));
            fs.rmSync(path.join(dir, "page.tsx"));
            expect(await route.callResolveAppFile(dir, "_404", true)).toBe(first);
            // The page is looked up again, and it's gone.
            expect(await route.callResolveAppFile(dir, "/page")).toBeNull();
        } finally {
            process.env.NODE_ENV = original;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("Lists each directory once in production, however many URLs are asked for — and every time in development.", async () => {
        const original = process.env.NODE_ENV;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rrst-listing-cache-"));
        fs.writeFileSync(path.join(dir, "page.tsx"), "export default function Page() { return null; }");
        fs.writeFileSync(path.join(dir, "[id].tsx"), "export default function Page() { return null; }");
        const readdir = vi.spyOn(fs.promises, "readdir");
        try {
            process.env.NODE_ENV = "production";
            const route = new TestableReactRoute();
            for (let i = 0; i < 20; i++) await route.callResolveAppFile(dir, `/made-up-${i}`);
            await route.callResolveAppFile(dir, "/page");
            expect(readdir.mock.calls.filter(([d]) => d === dir)).toHaveLength(1);
            expect((route as any).dirListings.size).toBe(1);

            readdir.mockClear();
            process.env.NODE_ENV = "development";
            const dev = new TestableReactRoute();
            await dev.callResolveAppFile(dir, "/page");
            await dev.callResolveAppFile(dir, "/page");
            expect(readdir.mock.calls.filter(([d]) => d === dir)).toHaveLength(2);
            expect((dev as any).dirListings.size).toBe(0);
        } finally {
            readdir.mockRestore();
            process.env.NODE_ENV = original;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("Matches a URL's segments against the names a directory really has, whatever the filesystem would answer for.", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rrst-exact-case-"));
        fs.mkdirSync(path.join(dir, "Sub"));
        fs.writeFileSync(path.join(dir, "Pets.tsx"), "export default function Page() { return null; }");
        fs.writeFileSync(path.join(dir, "Sub", "index.tsx"), "export default function Page() { return null; }");
        try {
            const route = new TestableReactRoute();
            expect((await route.callResolveAppFile(dir, "/Pets"))?.template).toBe("/Pets");
            expect((await route.callResolveAppFile(dir, "/Sub"))?.template).toBe("/Sub");
            // A case-insensitive filesystem would find these too: they're a different page, not this one.
            expect(await route.callResolveAppFile(dir, "/pets")).toBeNull();
            expect(await route.callResolveAppFile(dir, "/PETS")).toBeNull();
            expect(await route.callResolveAppFile(dir, "/sub")).toBeNull();
            expect(await route.callResolveAppFile(dir, "/sub/index")).toBeNull();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("Copes with a directory its remembered listing still names having gone since (production).", async () => {
        const original = process.env.NODE_ENV;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rrst-vanished-"));
        fs.mkdirSync(path.join(dir, "sub"));
        fs.writeFileSync(path.join(dir, "sub", "x.tsx"), "export default function Page() { return null; }");
        try {
            process.env.NODE_ENV = "production";
            const route = new TestableReactRoute();
            expect((await route.callResolveAppFile(dir, "/sub/x"))?.template).toBe("/sub/x");
            fs.rmSync(path.join(dir, "sub"), { recursive: true });
            expect(await route.callResolveAppFile(dir, "/sub/x")).toBeNull();
        } finally {
            process.env.NODE_ENV = original;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("Doesn't resolve a URL to a directory that has no index of its own.", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rrst-no-index-"));
        fs.mkdirSync(path.join(dir, "empty"));
        try {
            expect(await new TestableReactRoute().callResolveAppFile(dir, "/empty")).toBeNull();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("Gives the template of the file, not of how the URL spelled it: /index and /pets/index are / and /pets.", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rrst-template-"));
        fs.mkdirSync(path.join(dir, "pets"));
        fs.writeFileSync(path.join(dir, "index.tsx"), "export default function Page() { return null; }");
        fs.writeFileSync(path.join(dir, "pets", "index.tsx"), "export default function Page() { return null; }");
        try {
            const route = new TestableReactRoute();
            expect((await route.callResolveAppFile(dir, "/index"))?.template).toBe("/");
            expect((await route.callResolveAppFile(dir, "/pets"))?.template).toBe("/pets");
            expect((await route.callResolveAppFile(dir, "/pets/index"))?.template).toBe("/pets");
        } finally {
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
        const load = vi.fn().mockResolvedValue({ html: "<html>cached-value</html>" });
        route.setCacheClient({ load, save: vi.fn() });
        const result = await route.get(fakeRequest({ path: "/" }), fakeResponse());
        expect(result).toBe("<html>cached-value</html>");
        expect(load).toHaveBeenCalled();
    });

    it("Renders and writes through to the cache on a cache miss.", async () => {
        const route = new AppRoute();
        route.setLogger(noopLogger);
        const load = vi.fn().mockResolvedValue(undefined);
        const save = vi.fn();
        route.setCacheClient({ load, save });
        const result = await route.get(fakeRequest({ path: "/" }), fakeResponse());
        expect(result).toContain("<p>Home</p>");
        expect(save).toHaveBeenCalledWith(expect.any(String), expect.any(Object), (route as any).cacheTTL);
    });

    it("Falls through to rendering (rather than throwing) when the cache read fails.", async () => {
        const route = new AppRoute();
        const warn = vi.fn();
        route.setLogger({ ...noopLogger, warn });
        const load = vi.fn().mockRejectedValue(new Error("redis down"));
        const save = vi.fn();
        route.setCacheClient({ load, save });
        const result = await route.get(fakeRequest({ path: "/" }), fakeResponse());
        expect(String(result)).toContain("<p>Home</p>");
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("Cache read failed"), expect.any(Error));
    });

    it("Does not crash the request when the cache write fails.", async () => {
        const route = new AppRoute();
        const warn = vi.fn();
        route.setLogger({ ...noopLogger, warn });
        const load = vi.fn().mockResolvedValue(undefined);
        const save = vi.fn().mockRejectedValue(new Error("redis down"));
        route.setCacheClient({ load, save });
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
        const load = vi.fn().mockResolvedValue(undefined);
        const save = vi.fn();
        route.setCacheClient({ load, save });

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
        expect(save).toHaveBeenCalledTimes(1);
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

    it("Passes the merged page props through to _layout.tsx, not just the page component.", async () => {
        class LayoutPropsRoute extends TestableReactRoute {
            protected readonly appDir: string = "test/app-layout-props";
            protected override async fetchProps(): Promise<any> {
                return { siteTitle: "Custom Title" };
            }
        }
        const route = new LayoutPropsRoute();
        route.setLogger(noopLogger);
        const result = String(
            await route.get(fakeRequest({ path: "/", user: { uid: "u1" } }), fakeResponse()),
        );
        expect(result).toContain("<title>Custom Title</title>");
        expect(result).toContain('data-user-uid="u1"');
        expect(result).toContain("<p>Home</p>");
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

    it("Injects props containing String.replace '$' patterns verbatim rather than expanding them.", () => {
        delete process.env.NODE_ENV;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rrst-inject-dollar-"));
        const manifestPath = path.join(dir, "manifest.json");
        const pagePath = path.resolve(process.cwd(), "test/app/index.tsx");
        const entryKey = path.relative(process.cwd(), pagePath).replace(/\\/g, "/");
        fs.writeFileSync(manifestPath, JSON.stringify({ [entryKey]: { file: "assets/bundle.js" } }));
        try {
            const route = new TestableReactRoute();
            route.setLogger(noopLogger);
            route.setManifestPath(manifestPath);
            const props ={ q: "$`$&$'$$" };
            const result = route.callInjectHydrationAssets("<body>PAGE</body>", props, pagePath);
            const match = /id="react-props">(.*?)<\/script>/.exec(result);
            expect(JSON.parse(match![1])).toEqual(props);
            expect(result.split("PAGE").length).toBe(2);
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

describe("ReactRoute.handleStaticPaths / STATIC_PATHS_ROUTE gating", () => {
    class AppRoute extends TestableReactRoute {
        protected readonly appDir: string = "test/app";
    }

    let originalEnvVar: string | undefined;

    beforeEach(() => {
        originalEnvVar = process.env[STATIC_EXPORT_ENV_VAR];
    });

    afterEach(() => {
        if (originalEnvVar === undefined) delete process.env[STATIC_EXPORT_ENV_VAR];
        else process.env[STATIC_EXPORT_ENV_VAR] = originalEnvVar;
    });

    it("get() falls through to normal 404 page resolution for STATIC_PATHS_ROUTE when the " +
        "export-mode env var is not set — the endpoint must never be reachable outside export.", async () => {
        delete process.env[STATIC_EXPORT_ENV_VAR];
        const route = new AppRoute();
        route.setLogger(noopLogger);
        const res = fakeResponse();
        await route.get(fakeRequest({ path: STATIC_PATHS_ROUTE }), res);
        expect(res.status).toHaveBeenCalledWith(404);
        expect((res.send as any).mock.calls[0]?.[0]).toContain("Page not found");
    });

    it("get() serves JSON from STATIC_PATHS_ROUTE when the export-mode env var is set.", async () => {
        process.env[STATIC_EXPORT_ENV_VAR] = "true";
        const route = new AppRoute();
        route.setLogger(noopLogger);
        const res = fakeResponse();
        const result = await route.get(fakeRequest({ path: STATIC_PATHS_ROUTE }), res);
        expect(result).toBe(res);
        expect(res.setHeader).toHaveBeenCalledWith("content-type", "application/json");
        const body = JSON.parse((res.send as any).mock.calls[0][0]);
        expect(body["/pets/:id"]).toEqual(expect.arrayContaining(["/pets/1", "/pets/2"]));
    });

    it("Unions and dedupes entries from a page's own getStaticPaths() and a matching dynamic " +
        "@ReactService's getStaticPaths(), rather than one taking precedence.", async () => {
        const route = new AppRoute();
        route.setLogger(noopLogger);
        route.setDynamicServices([
            {
                template: "/pets/:id",
                instance: { getStaticPaths: async () => [{ id: "2" }, { id: "3" }] },
            },
        ]);
        const res = fakeResponse();
        await route.callHandleStaticPaths(res);
        const body = JSON.parse((res.send as any).mock.calls[0][0]);
        // Page contributes 1, 2; service contributes 2, 3 — union deduped, not one replacing the other.
        expect(body["/pets/:id"].sort()).toEqual(["/pets/1", "/pets/2", "/pets/3"]);
    });

    it("Skips a getStaticPaths() entry missing a required param instead of producing a broken URL.", async () => {
        const route = new AppRoute();
        route.setLogger(noopLogger);
        route.setDynamicServices([
            { template: "/pets/:id", instance: { getStaticPaths: async () => [{ notId: "x" }] } },
        ]);
        const res = fakeResponse();
        await route.callHandleStaticPaths(res);
        const body = JSON.parse((res.send as any).mock.calls[0][0]);
        // The malformed service entry contributes nothing, but the page's own two entries still do.
        expect(body["/pets/:id"].sort()).toEqual(["/pets/1", "/pets/2"]);
    });

    it("Tolerates a getStaticPaths() that resolves undefined/null instead of an array.", async () => {
        const route = new AppRoute();
        route.setLogger(noopLogger);
        route.setDynamicServices([
            { template: "/pets/:id", instance: { getStaticPaths: async () => undefined } },
        ]);
        const res = fakeResponse();
        await route.callHandleStaticPaths(res);
        const body = JSON.parse((res.send as any).mock.calls[0][0]);
        // The service contributes nothing, but the page's own two entries still do.
        expect(body["/pets/:id"].sort()).toEqual(["/pets/1", "/pets/2"]);
    });

    it("Logs a warning and continues (rather than crashing the endpoint) when a page's " +
        "getStaticPaths() throws — a sibling dynamic route is still enumerated normally.", async () => {
        class ThrowingRoute extends TestableReactRoute {
            protected readonly appDir: string = "test/fixtures/getstaticpaths-throws";
        }
        const warn = vi.fn();
        const route = new ThrowingRoute();
        route.setLogger({ ...noopLogger, warn });
        const res = fakeResponse();
        await route.callHandleStaticPaths(res);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining("getStaticPaths() failed for page"), expect.any(Error)
        );
        const body = JSON.parse((res.send as any).mock.calls[0][0]);
        expect(body).toEqual({});
    });

    it("Logs a warning and continues when a @ReactService's getStaticPaths() throws.", async () => {
        const warn = vi.fn();
        const route = new AppRoute();
        route.setLogger({ ...noopLogger, warn });
        route.setDynamicServices([
            {
                template: "/pets/:id",
                instance: {
                    getStaticPaths: async () => {
                        throw new Error("db unavailable");
                    },
                },
            },
        ]);
        const res = fakeResponse();
        await route.callHandleStaticPaths(res);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining("getStaticPaths() failed for the @ReactService matching"), expect.any(Error)
        );
        // The page's own entries still come through despite the service failing.
        const body = JSON.parse((res.send as any).mock.calls[0][0]);
        expect(body["/pets/:id"].sort()).toEqual(["/pets/1", "/pets/2"]);
    });

    it("Omits a dynamic-route template entirely from the response when nothing enumerates it.", async () => {
        const route = new AppRoute();
        route.setLogger(noopLogger);
        const res = fakeResponse();
        await route.callHandleStaticPaths(res);
        const body = JSON.parse((res.send as any).mock.calls[0][0]);
        // test/app/pets/[id]/reviews/[reviewId].tsx has no getStaticPaths and no matching service.
        expect(body["/pets/:id/reviews/:reviewId"]).toBeUndefined();
    });
});
