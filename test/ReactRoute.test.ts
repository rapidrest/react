///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import config from "./config";
import { request } from "@rapidrest/service-core/dist/lib/test/request.js";
import { Server, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";

// AppRouter is mounted at /app/* — all React pages are served under that prefix.
const UI_BASE = "/app";

describe("ReactRoute Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server(config, "./test/server", logger, objectFactory);

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
});
