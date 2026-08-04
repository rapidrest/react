///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import path from "node:path";
import { createViteConfig } from "../src/vite.js";

// The hydration plugin exposes hooks: options(opts), resolveId(id), load(id).
// It is the second plugin returned (after @vitejs/plugin-react's react()).
async function getHydrationPlugin(options?: Parameters<typeof createViteConfig>[0]) {
    const config: any = await createViteConfig(options);
    return { config, plugin: config.plugins[1] };
}

describe("createViteConfig", () => {
    it("Defaults appDir to 'app', outDir to 'dist/public', and includes no user plugins.", async () => {
        // No top-level "app" directory exists at the repo root, so page discovery finds nothing.
        const { config, plugin } = await getHydrationPlugin();
        expect(config.plugins).toHaveLength(2);
        expect(plugin.name).toBe("rapidrest-hydration");
        expect(config.build.outDir).toBe("dist/public");
        expect(config.build.manifest).toBe(true);
        expect(config.build.emptyOutDir).toBe(true);
    });

    it("Appends user-supplied plugins after the built-in ones.", async () => {
        const customPlugin = { name: "custom-plugin" };
        const { config } = await getHydrationPlugin({ appDir: "test/fixtures/vite-app", plugins: [customPlugin] });
        expect(config.plugins).toHaveLength(3);
        expect(config.plugins[2]).toBe(customPlugin);
    });

    it("Honors a custom outDir.", async () => {
        const { config } = await getHydrationPlugin({ outDir: "custom/out" });
        expect(config.build.outDir).toBe("custom/out");
    });
});

describe("rapidrest-hydration plugin", () => {
    describe("options() — page discovery", () => {
        it("Returns null when appDir does not exist.", async () => {
            const { plugin } = await getHydrationPlugin({ appDir: "test/fixtures/does-not-exist" });
            expect(plugin.options({})).toBeNull();
        });

        it("Returns null when appDir exists but has no matching entries.", async () => {
            const { plugin } = await getHydrationPlugin({ appDir: "test/fixtures/vite-empty" });
            expect(plugin.options({})).toBeNull();
        });

        it("Discovers top-level .tsx files, excludes underscore-prefixed files/dirs, includes " +
            "subdirectory index.tsx one level deep, and excludes subdirectories without an index.tsx.", async () => {
            const { plugin } = await getHydrationPlugin({ appDir: "test/fixtures/vite-app" });
            const result = plugin.options({});
            expect(result).not.toBeNull();
            const keys = Object.keys(result.input).sort();
            expect(keys).toEqual(["test/fixtures/vite-app/page1.tsx", "test/fixtures/vite-app/sub/index.tsx"]);
            for (const key of keys) {
                expect(result.input[key]).toBe(`\0rapidrest-entry:${key}`);
            }
        });

        it("Discovers index.tsx at arbitrary nesting depth (regression: previously only 1 level deep " +
            "was scanned, so e.g. auth/login/index.tsx was silently skipped), while still excluding " +
            "non-index files and underscore-prefixed directories at any depth.", async () => {
            const { plugin } = await getHydrationPlugin({ appDir: "test/fixtures/vite-app-nested" });
            const result = plugin.options({});
            expect(result).not.toBeNull();
            const keys = Object.keys(result.input).sort();
            expect(keys).toEqual(["test/fixtures/vite-app-nested/auth/login/index.tsx"]);
            expect(result.input[keys[0]]).toBe(`\0rapidrest-entry:${keys[0]}`);
        });

        it("Merges with an existing string rollup input.", async () => {
            const { plugin } = await getHydrationPlugin({ appDir: "test/fixtures/vite-app/sub" });
            const result = plugin.options({ input: "existing.ts" });
            expect(result.input["existing.ts"]).toBe("existing.ts");
            expect(result.input["test/fixtures/vite-app/sub/index.tsx"]).toBeDefined();
        });

        it("Merges with an existing array rollup input.", async () => {
            const { plugin } = await getHydrationPlugin({ appDir: "test/fixtures/vite-app/sub" });
            const result = plugin.options({ input: ["a.ts", "b.ts"] });
            expect(result.input["a.ts"]).toBe("a.ts");
            expect(result.input["b.ts"]).toBe("b.ts");
            expect(result.input["test/fixtures/vite-app/sub/index.tsx"]).toBeDefined();
        });

        it("Merges with an existing object rollup input.", async () => {
            const { plugin } = await getHydrationPlugin({ appDir: "test/fixtures/vite-app/sub" });
            const result = plugin.options({ input: { "c.ts": "c.ts" } });
            expect(result.input["c.ts"]).toBe("c.ts");
            expect(result.input["test/fixtures/vite-app/sub/index.tsx"]).toBeDefined();
        });

        it("Defaults to an empty existing input when opts.input is unset.", async () => {
            const { plugin } = await getHydrationPlugin({ appDir: "test/fixtures/vite-app/sub" });
            const result = plugin.options({});
            expect(Object.keys(result.input)).toEqual(["test/fixtures/vite-app/sub/index.tsx"]);
        });

        it("Preserves other rollup options alongside the merged input.", async () => {
            const { plugin } = await getHydrationPlugin({ appDir: "test/fixtures/vite-app/sub" });
            const result = plugin.options({ preserveSymlinks: true });
            expect(result.preserveSymlinks).toBe(true);
        });
    });

    describe("resolveId()", () => {
        it("Resolves a virtual entry id.", async () => {
            const { plugin } = await getHydrationPlugin({ appDir: "test/fixtures/vite-app/sub" });
            const { input } = plugin.options({});
            const virtualId = input["test/fixtures/vite-app/sub/index.tsx"];
            expect(plugin.resolveId(virtualId)).toBe(virtualId);
        });

        it("Ignores a non-virtual id.", async () => {
            const { plugin } = await getHydrationPlugin({ appDir: "test/fixtures/vite-app/sub" });
            expect(plugin.resolveId("some/other/id.ts")).toBeUndefined();
        });
    });

    describe("load()", () => {
        it("Generates a hydration entry module for a virtual id.", async () => {
            const { plugin } = await getHydrationPlugin({ appDir: "test/fixtures/vite-app/sub" });
            const { input } = plugin.options({});
            const key = "test/fixtures/vite-app/sub/index.tsx";
            const virtualId = input[key];
            const code = plugin.load(virtualId);
            const expectedAbsPath = path.resolve(key).replace(/\\/g, "/");
            expect(code).toContain(`import Component from ${JSON.stringify(expectedAbsPath)};`);
            expect(code).toContain(`import { hydrateRoute } from "@rapidrest/react/client";`);
            expect(code).toContain("hydrateRoute(Component);");
        });

        it("Ignores a non-virtual id.", async () => {
            const { plugin } = await getHydrationPlugin({ appDir: "test/fixtures/vite-app/sub" });
            expect(plugin.load("some/other/id.ts")).toBeUndefined();
        });
    });
});
