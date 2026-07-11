///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import config from "./config";
import { request } from "@rapidrest/service-core/test";
import { Server, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { ReactRoute } from "../src/ReactRoute.js";

// AppRouter is mounted at /app/* — all React pages are served under that prefix.
const UI_BASE = "/app";

// Exposes the protected resolveAppFile method for direct unit testing.
class TestableReactRoute extends ReactRoute {
    public callResolveAppFile(appDir: string, segment: string): string | null {
        return this.resolveAppFile(appDir, segment);
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
