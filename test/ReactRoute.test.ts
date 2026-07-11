///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import config from "./config";
import { request } from "@rapidrest/service-core/test";
import { Server, ObjectFactory, HttpRequest } from "@rapidrest/service-core";
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

// Exposes protected methods for direct unit testing.
class TestableReactRoute extends ReactRoute {
    public callResolveAppFile(appDir: string, segment: string): string | null {
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

    it("Resolves a page file that exists within the app directory.", () => {
        const result = route.callResolveAppFile("test/app", "/index");
        expect(result).not.toBeNull();
        expect(result).toMatch(/index\.tsx$/);
    });

    it("Resolves a nested page file using the index convention.", () => {
        const result = route.callResolveAppFile("test/app", "/auth/login");
        expect(result).not.toBeNull();
        expect(result).toMatch(/auth[\\/]login[\\/]index\.tsx$/);
    });

    it("Returns null for a segment with no matching file.", () => {
        const result = route.callResolveAppFile("test/app", "/does-not-exist");
        expect(result).toBeNull();
    });

    it("Returns null for a path traversal attempt that escapes the app directory.", () => {
        // Without the containment check this would resolve to the real src/ReactRoute.tsx file.
        const result = route.callResolveAppFile("test/app", "/../../src/ReactRoute");
        expect(result).toBeNull();
    });

    it("Returns null for a deep path traversal attempt reaching outside the project.", () => {
        const result = route.callResolveAppFile("test/app", "/../../../../../../../../etc/passwd");
        expect(result).toBeNull();
    });

    it("Returns null for a traversal attempt that only partially matches the app dir prefix.", () => {
        // "test/app-evil" should not be treated as being inside "test/app".
        const result = route.callResolveAppFile("test/app", "/../app-evil/index");
        expect(result).toBeNull();
    });

    it("Still resolves segments that legitimately stay within the app directory after normalization.", () => {
        const result = route.callResolveAppFile("test/app", "/../app/index");
        expect(result).not.toBeNull();
        expect(result).toMatch(/index\.tsx$/);
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
