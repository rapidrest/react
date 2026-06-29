///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import fs from "node:fs";
import path from "node:path";

/**
 * Configuration options for createViteConfig.
 */
export interface RapidRestViteOptions {
    /**
     * Directory containing front-end React page components, relative to the project root.
     * Convention:
     * - Top-level `.tsx` files (excluding `_*` prefixed) become hydration entry points.
     * - `index.tsx` inside a non-`_*` subdirectory also becomes an entry point.
     * - Files prefixed with `_` (e.g. `_layout.tsx`, `_styles/`) are excluded.
     * - Non-index files inside subdirectories are treated as sub-components — not entries.
     *
     * The manifest key for each entry is its path relative to the project root
     * (e.g. `"app/pets.tsx"`), which is what ReactRoute derives from the resolved page file.
     *
     * Default: `"app"`
     */
    appDir?: string;

    /**
     * Output directory for production builds. RapidREST auto-serves `<basePath>/public/`,
     * so this should resolve to that directory at runtime.
     * Default: `"dist/public"`
     */
    outDir?: string;

    /**
     * Additional Vite plugins to include (e.g. `@tailwindcss/vite`, `vite-plugin-svgr`).
     * These are appended after the built-in React and hydration plugins.
     */
    plugins?: any[];
}

const VIRTUAL_PREFIX = "\0rapidrest-entry:";

/**
 * Scans `appDir` and returns a rollup input map for all page entry points.
 *
 * Included:
 * - `app/*.tsx` — top-level files, excluding those starting with `_`
 * - `app/<dir>/index.tsx` — index files one level deep, excluding `_*` dirs
 *
 * The input KEY (e.g. `"app/pets.tsx"`) becomes the Vite manifest key because
 * Vite uses `chunk.name` (the rollup input key) for virtual-module entries.
 */
function findPageEntries(appDir: string): Record<string, string> {
    const result: Record<string, string> = {};
    const absDir = path.resolve(appDir);
    if (!fs.existsSync(absDir)) return result;

    for (const entry of fs.readdirSync(absDir)) {
        if (entry.startsWith("_")) continue;
        const fullPath = path.join(absDir, entry);
        const stat = fs.statSync(fullPath);

        if (stat.isFile() && entry.endsWith(".tsx")) {
            const key = path.posix.join(appDir.replace(/\\/g, "/"), entry);
            result[key] = VIRTUAL_PREFIX + key;
        } else if (stat.isDirectory()) {
            const indexPath = path.join(fullPath, "index.tsx");
            if (fs.existsSync(indexPath)) {
                const key = path.posix.join(appDir.replace(/\\/g, "/"), entry, "index.tsx");
                result[key] = VIRTUAL_PREFIX + key;
            }
        }
    }
    return result;
}

/**
 * Vite plugin that auto-discovers page entry points from `appDir` and generates
 * virtual hydration entry modules for each — no hand-written `*.entry.tsx` files needed.
 *
 * Each virtual module (prefixed `\0`) calls `hydrateRoute(DefaultExport)`.
 * Vite treats `\0`-prefixed IDs as virtual (no real facadeModuleId), so it falls back
 * to `chunk.name` — the rollup input key — as the manifest key. This makes
 * `clientEntryKey = "app/pets.tsx"` resolve correctly in ReactRoute.
 */
function rapidRestHydrationPlugin(appDir: string) {
    return {
        name: "rapidrest-hydration",

        options(opts: any) {
            const entries = findPageEntries(appDir);
            if (Object.keys(entries).length === 0) return null;

            let existing: Record<string, string> = {};
            if (typeof opts.input === "string") {
                existing = { [opts.input]: opts.input };
            } else if (Array.isArray(opts.input)) {
                existing = Object.fromEntries(opts.input.map((f: string) => [f, f]));
            } else if (opts.input) {
                existing = opts.input as Record<string, string>;
            }

            return { ...opts, input: { ...existing, ...entries } };
        },

        resolveId(id: string) {
            if (id.startsWith(VIRTUAL_PREFIX)) return id;
        },

        load(id: string) {
            if (!id.startsWith(VIRTUAL_PREFIX)) return;
            const sourcePath = id.slice(VIRTUAL_PREFIX.length);
            const absPath = path.resolve(sourcePath).replace(/\\/g, "/");
            return [
                `import Component from ${JSON.stringify(absPath)};`,
                `import { hydrateRoute } from "@rapidrest/react/client";`,
                `hydrateRoute(Component);`,
            ].join("\n");
        },
    };
}

/**
 * Creates a Vite build configuration for `@rapidrest/react` projects.
 *
 * Auto-discovers React page components from `appDir` and generates client hydration
 * entry points for each. No manual entry listing or `*.entry.tsx` files needed.
 *
 * RapidREST is the only runtime server. Vite is used purely as a build tool
 * (`vite build` / `vite build --watch`). Output goes to `dist/public/` where
 * RapidREST auto-serves static files, and a manifest is generated for hashed URL resolution.
 *
 * @example
 * // vite.config.ts
 * import { createViteConfig } from "@rapidrest/react/vite";
 * export default createViteConfig({ appDir: "app" });
 *
 * @example
 * // With Tailwind CSS
 * import tailwindcss from "@tailwindcss/vite";
 * export default createViteConfig({ appDir: "app", plugins: [tailwindcss()] });
 */
export async function createViteConfig(options: RapidRestViteOptions = {}) {
    const { defineConfig } = await import("vite");
    const { default: react } = await import("@vitejs/plugin-react");

    const { appDir = "app", outDir = "dist/public", plugins: userPlugins = [] } = options;

    return defineConfig({
        plugins: [react(), rapidRestHydrationPlugin(appDir), ...userPlugins],
        build: {
            outDir,
            manifest: true,
            emptyOutDir: true,
        },
    });
}
