///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findAppDirShell } from "../src/appDirScan.js";
import { createViteConfig, routerEntrySource } from "../src/vite.js";

const SHELL_APP = "test/fixtures/shell-app";
const PLAIN_APP = "test/fixtures/router-app";
const ROUTER_ID = "\0rapidrest-router:";

const abs = (rel: string) => path.resolve(rel).replace(/\\/g, "/");

async function hydrationPlugin(options: Parameters<typeof createViteConfig>[0]) {
    const config: any = await createViteConfig(options);
    return config.plugins[1];
}

describe("findAppDirShell", () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "rrst-shell-scan-"));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("finds _shell.tsx next to the layout", () => {
        fs.writeFileSync(path.join(dir, "_shell.tsx"), "export default () => null;");
        expect(findAppDirShell(dir)).toBe(path.resolve(dir, "_shell.tsx"));
    });

    it("finds the same places the server looks: an index in a _shell directory, and a .jsx", () => {
        fs.mkdirSync(path.join(dir, "_shell"));
        fs.writeFileSync(path.join(dir, "_shell", "index.tsx"), "export default () => null;");
        expect(findAppDirShell(dir)).toBe(path.resolve(dir, "_shell", "index.tsx"));

        fs.rmSync(path.join(dir, "_shell"), { recursive: true });
        fs.writeFileSync(path.join(dir, "_shell.jsx"), "export default () => null;");
        expect(findAppDirShell(dir)).toBe(path.resolve(dir, "_shell.jsx"));
    });

    it("prefers _shell.tsx to the others", () => {
        fs.mkdirSync(path.join(dir, "_shell"));
        fs.writeFileSync(path.join(dir, "_shell", "index.tsx"), "");
        fs.writeFileSync(path.join(dir, "_shell.tsx"), "");
        expect(findAppDirShell(dir)).toBe(path.resolve(dir, "_shell.tsx"));
    });

    it("is null for an app without one, and for a directory that doesn't exist", () => {
        fs.writeFileSync(path.join(dir, "_layout.tsx"), "");
        expect(findAppDirShell(dir)).toBeNull();
        expect(findAppDirShell(path.join(dir, "nope"))).toBeNull();
    });

    it("is never a page: the shell isn't in the app's routes", async () => {
        const plugin = await hydrationPlugin({ appDir: SHELL_APP, router: true });
        const inputs = Object.keys(plugin.options({}).input);
        expect(inputs).toContain(`${SHELL_APP}/pets.tsx`);
        expect(inputs.filter((input) => input.includes("_shell"))).toEqual([]);
    });
});

describe("routerEntrySource with a shell", () => {
    it("imports the app's shell into the entry, statically, and hands it to startRouter", () => {
        const code = routerEntrySource(SHELL_APP, ["index.tsx", "pets.tsx"]);

        expect(code.split("\n")).toEqual([
            'import { startRouter } from "@rapidrest/react/client";',
            `import Shell from ${JSON.stringify(abs(`${SHELL_APP}/_shell.tsx`))};`,
            "startRouter([",
            `    { template: "/", load: () => import(${JSON.stringify(abs(`${SHELL_APP}/index.tsx`))}) },`,
            `    { template: "/pets", load: () => import(${JSON.stringify(abs(`${SHELL_APP}/pets.tsx`))}) },`,
            "], { shell: Shell });",
        ]);
    });

    it("has no shell for an app that doesn't have one, exactly as before", () => {
        expect(routerEntrySource(PLAIN_APP, [])).toBe(
            ['import { startRouter } from "@rapidrest/react/client";', "startRouter([", "]);"].join("\n"),
        );
    });
});

describe("routerEntrySource with options", () => {
    it("puts the JSON-able settings in the startRouter call", () => {
        const code = routerEntrySource(
            PLAIN_APP,
            [],
            { prefetch: { idle: ["/", "/pets"], data: true, links: true }, focus: "#main", scroll: "preserve", pendingAttributes: true },
        );

        expect(code.split("\n").at(-1)).toBe(
            '], { effects: {"focus":"#main","scroll":"preserve"}, pendingAttributes: true, prefetch: {"idle":["/","/pets"],"data":true,"links":true} });',
        );
    });

    it("leaves out what wasn't set, and keeps `false`, which is a setting", () => {
        expect(routerEntrySource(PLAIN_APP, [], { scroll: false }).split("\n").at(-1)).toBe('], { effects: {"scroll":false} });');
        expect(routerEntrySource(PLAIN_APP, [], { focus: false }).split("\n").at(-1)).toBe('], { effects: {"focus":false} });');
        expect(routerEntrySource(PLAIN_APP, [], { pendingAttributes: false }).split("\n").at(-1)).toBe("]);");
        expect(routerEntrySource(PLAIN_APP, [], {}).split("\n").at(-1)).toBe("]);");
    });

    it("comes after the shell", () => {
        const code = routerEntrySource(SHELL_APP, [], { pendingAttributes: true });
        expect(code.split("\n").at(-1)).toBe("], { shell: Shell, pendingAttributes: true });");
    });
});

describe("createViteConfig({ router })", () => {
    it("takes an object of settings, which every routed app's entry is built with", async () => {
        const plugin = await hydrationPlugin({
            appDir: [SHELL_APP, PLAIN_APP],
            router: { prefetch: { idle: ["/pets"] } },
        });

        const inputs = Object.keys(plugin.options({}).input);
        expect(inputs).toContain(`${SHELL_APP}/__router`);
        expect(inputs).toContain(`${PLAIN_APP}/__router`);
        for (const app of [SHELL_APP, PLAIN_APP]) {
            expect(plugin.load(ROUTER_ID + app)).toContain('prefetch: {"idle":["/pets"]}');
        }
    });

    it("can pick the apps that get a router with appDirs, as the array form does", async () => {
        const plugin = await hydrationPlugin({
            appDir: [SHELL_APP, PLAIN_APP],
            router: { appDirs: [SHELL_APP], pendingAttributes: true },
        });

        const inputs = Object.keys(plugin.options({}).input);
        expect(inputs).toContain(`${SHELL_APP}/__router`);
        expect(inputs).not.toContain(`${PLAIN_APP}/__router`);
        expect(plugin.load(ROUTER_ID + SHELL_APP)).toContain("pendingAttributes: true");
    });

    it("is a router for every app with an empty object, with nothing added to the entries", async () => {
        const plugin = await hydrationPlugin({ appDir: PLAIN_APP, router: {} });
        expect(Object.keys(plugin.options({}).input)).toContain(`${PLAIN_APP}/__router`);
        expect(plugin.load(ROUTER_ID + PLAIN_APP).split("\n").at(-1)).toBe("]);");
    });

    it("still takes true and an array of apps", async () => {
        const all = await hydrationPlugin({ appDir: [SHELL_APP, PLAIN_APP], router: true });
        expect(Object.keys(all.options({}).input).filter((key) => key.endsWith("__router"))).toHaveLength(2);
        const some = await hydrationPlugin({ appDir: [SHELL_APP, PLAIN_APP], router: [PLAIN_APP] });
        expect(Object.keys(some.options({}).input).filter((key) => key.endsWith("__router"))).toEqual([`${PLAIN_APP}/__router`]);
    });
});
