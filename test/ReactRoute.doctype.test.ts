///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import config from "./config";
import { ObjectFactory, Server } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { exportStaticSite } from "../src/static.js";
import { NAVIGATION_HEADER } from "../src/routerCore.js";
import { STATIC_EXPORT_ENV_VAR, STATIC_PATHS_ROUTE } from "../src/routeMatch.js";

const DOCTYPE = "<!DOCTYPE html>";

// What Vite writes for a router build of the fixture app (see ReactRoute.router.test.ts for the full shape).
const APP = "test/fixtures/router-app";
const MANIFEST = {
    [`rapidrest-router:${APP}`]: { file: "assets/router-abc.js", name: `${APP}/__router`, isEntry: true },
    [`${APP}/index.tsx`]: { file: "assets/index-page.js", isDynamicEntry: true },
    [`rapidrest-entry:${APP}/index.tsx`]: {
        file: "assets/index-entry.js",
        name: `${APP}/index.tsx`,
        isEntry: true,
        imports: [`${APP}/index.tsx`],
    },
};

/** Every full HTML document the package sends starts with a doctype — a browser would render it in quirks mode otherwise. */
describe("ReactRoute emits <!DOCTYPE html>", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-doctype", logger, objectFactory });
    let tmpDir: string;

    const get = async (urlPath: string, headers: Record<string, string> = {}) => {
        const res = await fetch(`http://localhost:${server.port}${urlPath}`, { headers });
        return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text() };
    };
    const count = (text: string) => (text.match(/<!doctype/gi) ?? []).length;

    beforeAll(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rapidreact-doctype-"));
        const manifestPath = path.join(tmpDir, "manifest.json");
        fs.writeFileSync(manifestPath, JSON.stringify(MANIFEST));
        config.set("react:manifestPath", manifestPath);
        await server.start();
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("starts a normally rendered page with it, once.", async () => {
        const res = await get("/dt-normal/");
        expect(res.status).toBe(200);
        expect(res.body.startsWith(`${DOCTYPE}<html`)).toBe(true);
        expect(res.body).toContain("<p>Home</p>");
        expect(count(res.body)).toBe(1);
    });

    it("starts the _404 page with it.", async () => {
        const res = await get("/dt-normal/no-such-page");
        expect(res.status).toBe(404);
        expect(res.body.startsWith(DOCTYPE)).toBe(true);
        expect(res.body).toContain("Page not found");
        expect(count(res.body)).toBe(1);
    });

    it("starts the _500 page with it, with or without a layout.", async () => {
        const res = await get("/dt-throws/");
        expect(res.status).toBe(500);
        expect(res.body.startsWith(DOCTYPE)).toBe(true);
        expect(res.body).toContain("Internal server error");
        expect(count(res.body)).toBe(1);
    });

    it("starts the hard-coded 404 page, used when the app has no _404, with it.", async () => {
        const res = await get("/dt-no500/no-such-page");
        expect(res.status).toBe(404);
        expect(res.body.startsWith(`${DOCTYPE}<html><head></head><body><h1>404 Not Found</h1>`)).toBe(true);
    });

    it("starts the hard-coded 500 page, used when the app has no _500, with it.", async () => {
        const res = await get("/dt-no500/");
        expect(res.status).toBe(500);
        expect(res.body.startsWith(`${DOCTYPE}<html><head></head><body><h1>500 Internal Server Error</h1>`)).toBe(true);
    });

    it("starts the hard-coded 500 page, used when the _500 page itself fails, with it.", async () => {
        const res = await get("/dt-broken500/");
        expect(res.status).toBe(500);
        expect(res.body.startsWith(`${DOCTYPE}<html><head></head><body><h1>500 Internal Server Error</h1>`)).toBe(true);
    });

    it("starts a router-mode page, hydration assets and all, with it.", async () => {
        const res = await get("/dt-router/");
        expect(res.status).toBe(200);
        expect(res.body.startsWith(DOCTYPE)).toBe(true);
        expect(res.body).toContain("rapidrest-router");
        expect(count(res.body)).toBe(1);
    });

    it("does not add one to a client-navigation JSON payload.", async () => {
        const res = await get("/dt-router/", { [NAVIGATION_HEADER]: "1" });
        expect(res.status).toBe(200);
        expect(res.type).toContain("application/json");
        expect(res.body).not.toMatch(/doctype/i);
        expect(JSON.parse(res.body).route).toBe("/");
    });

    it("does not add one to a client-navigation status answer (no such page).", async () => {
        const res = await get("/dt-router/no-such-page", { [NAVIGATION_HEADER]: "1" });
        expect(res.status).toBe(404);
        expect(res.type).toContain("application/json");
        expect(JSON.parse(res.body)).toEqual({ status: 404 });
    });

    it("does not add one to the static-path enumeration JSON.", async () => {
        const original = process.env[STATIC_EXPORT_ENV_VAR];
        process.env[STATIC_EXPORT_ENV_VAR] = "true";
        try {
            const res = await get(`/dt-normal${STATIC_PATHS_ROUTE}`);
            expect(res.status).toBe(200);
            expect(res.type).toContain("application/json");
            expect(typeof JSON.parse(res.body)).toBe("object");
        } finally {
            if (original === undefined) delete process.env[STATIC_EXPORT_ENV_VAR];
            else process.env[STATIC_EXPORT_ENV_VAR] = original;
        }
    });

    it("does not add a second one to a document that already starts with one.", async () => {
        const res = await get("/dt-own/");
        expect(res.status).toBe(200);
        expect(res.body.startsWith("\n<!doctype HTML><html")).toBe(true);
        expect(count(res.body)).toBe(1);
    });

    it("is in every file a static export writes, 404.html included.", async () => {
        const result = await exportStaticSite({
            port: server.port,
            appDir: "test/app",
            routePrefix: "/dt-normal",
            outDir: tmpDir,
            assetsDir: path.join(tmpDir, "__no_assets__"),
            notFound: true,
        });
        expect(result.errors).toEqual([]);
        expect(result.pages.length).toBeGreaterThan(1);
        for (const page of result.pages) {
            expect(fs.readFileSync(page.outFile, "utf-8").startsWith(DOCTYPE)).toBe(true);
        }
        const notFound = fs.readFileSync(path.join(tmpDir, "404.html"), "utf-8");
        expect(notFound.startsWith(DOCTYPE)).toBe(true);
        expect(notFound).toContain("Page not found");
    });
});
