///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { HttpRequest, HttpResponse } from "@rapidrest/service-core";
import { ReactRoute } from "../src/ReactRoute.js";
import { createViteConfig } from "../src/vite.js";

/*
 * A real `vite build` of an app with a shell — the plugin's entries and the manifest Vite writes for them — read by a real
 * `ReactRoute`, to see that the pieces this package builds and reads agree: the shell is part of the router entry (and so
 * is its stylesheet, which the server puts in the page), and the page entries the server finds pages by are all still there.
 */

const APP = "test/fixtures/shell-app";

class ShellRoute extends ReactRoute {
    protected readonly appDir: string = APP;
    protected readonly router: boolean = true;

    constructor() {
        super();
        (this as any).logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    }

    public setManifestPath(p: string) {
        (this as any).manifestPath = p;
    }
}

const request = (path: string): HttpRequest =>
    ({ method: "GET", path, url: path, headers: {}, params: {}, query: {}, cookies: {}, signedCookies: {}, socket: {} }) as any;

const response = (): HttpResponse =>
    ({ status: vi.fn(), setHeader: vi.fn(), getHeader: vi.fn(), send: vi.fn(), end: vi.fn() }) as any;

describe("a built app with a shell", () => {
    let outDir: string;
    let manifest: Record<string, any>;
    const files = () => Object.values(manifest).map((chunk) => chunk.file);
    const read = (file: string) => fs.readFileSync(path.join(outDir, file), "utf-8");

    beforeAll(async () => {
        const { build, mergeConfig } = await import("vite");
        outDir = fs.mkdtempSync(path.join(os.tmpdir(), "rrst-shell-build-"));
        const config = await createViteConfig({
            appDir: APP,
            outDir,
            router: { prefetch: { idle: ["/pets"] }, focus: "#main" },
        });
        await build(
            mergeConfig(config, {
                root: process.cwd(),
                logLevel: "silent",
                // The entry imports the package by name, which for a build inside the package means its own source.
                resolve: { alias: { "@rapidrest/react/client": path.resolve("src/client.ts") } },
                build: { outDir, emptyOutDir: true, minify: false },
            }) as any,
        );
        manifest = JSON.parse(fs.readFileSync(path.join(outDir, ".vite", "manifest.json"), "utf-8"));
    }, 120_000);

    afterAll(() => {
        fs.rmSync(outDir, { recursive: true, force: true });
    });

    it("has the router entry, and an entry for every page (and not for the shell) for the server to find pages by", () => {
        const names = Object.values(manifest)
            .map((chunk) => chunk.name)
            .filter(Boolean);
        expect(names).toContain(`${APP}/__router`);
        for (const page of ["index", "pets", "plain", "boom"]) expect(names).toContain(`${APP}/${page}.tsx`);
        expect(names.filter((name) => name.includes("_shell"))).toEqual([]);
    });

    it("has the shell, its stylesheet and the settings in the router entry: the client can render it on the first page", () => {
        const entry = Object.values(manifest).find((chunk) => chunk.name === `${APP}/__router`);
        // The shell is imported statically, so its code is the entry's, or a chunk the entry imports — never a page's.
        const code = [entry, ...(entry.imports ?? []).map((key: string) => manifest[key])].map((chunk) => read(chunk.file)).join("\n");
        expect(code).toContain("data-user"); // (the shell's own markup)
        expect(code).toContain('id: "shell"');
        expect(code).toContain('"idle"');
        expect(code).toContain('"focus"');
        const css = [entry, ...(entry.imports ?? []).map((key: string) => manifest[key])].flatMap((chunk) => chunk.css ?? []);
        expect(css.some((file: string) => read(file).includes("#shell"))).toBe(true);
    });

    it("is read by ReactRoute: the page's document has the router entry, and the shell's stylesheet from its manifest record", async () => {
        const route = new ShellRoute();
        route.setManifestPath(path.join(outDir, ".vite", "manifest.json"));

        const html: string = (await route.get(request("/pets"), response()));

        const entry = Object.values(manifest).find((chunk) => chunk.name === `${APP}/__router`);
        expect(html).toContain(`<script type="module" src="/${entry.file}"></script>`);
        const shellCss = [entry, ...(entry.imports ?? []).map((key: string) => manifest[key])]
            .flatMap((chunk) => chunk.css ?? [])
            .filter((file: string) => read(file).includes("#shell"));
        expect(shellCss).toHaveLength(1);
        expect(html).toContain(`<link rel="stylesheet" href="/${shellCss[0]}">`);
        expect(html).toContain('"shell":true');
        expect(html).toContain('<div id="react-root"><div id="shell"');
        // ...and the assets exist: what the server names is what the build wrote.
        expect(files().every((file: string) => fs.existsSync(path.join(outDir, file)))).toBe(true);
    });
});
