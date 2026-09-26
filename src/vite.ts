///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import path from "node:path";
import { fileToRouteTemplate, findAppDirShell, scanAppDirPages } from "./appDirScan.js";
import { ROUTER_ENTRY_NAME } from "./routerCore.js";

/**
 * Configuration options for createViteConfig.
 */
export interface RapidRestViteOptions {
    /**
     * Directory (or directories, for a multi-app project — one per `ReactRoute` subclass)
     * containing front-end React page components, relative to the project root. Convention:
     * - Top-level `.tsx` files (excluding `_*` prefixed) become hydration entry points.
     * - `index.tsx` inside a non-`_*` subdirectory also becomes an entry point.
     * - Files prefixed with `_` (e.g. `_layout.tsx`, `_styles/`) are excluded.
     * - Non-index files inside subdirectories are treated as sub-components — not entries.
     *
     * The manifest key for each entry is its path relative to the project root
     * (e.g. `"app/pets.tsx"`), which is what ReactRoute derives from the resolved page file.
     * Multiple `appDir`s are merged into one build/manifest — entry keys are already prefixed
     * by their own `appDir`, so there's no collision risk between apps.
     *
     * Default: `"app"`
     */
    appDir?: string | string[];

    /**
     * Output directory for production builds. RapidREST auto-serves `<basePath>/public/`,
     * so this should resolve to that directory at runtime.
     * Default: `"dist/public"`
     */
    outDir?: string;

    /**
     * Client-side navigation: for each of these `appDir`s (`true` for all of them), also build a router entry. The
     * entry hydrates whichever page the server rendered and, from then on, navigates between the app's pages without
     * loading a whole document, loading each page's module (a separate chunk, fetched on demand or ahead of time) and
     * its data as it's needed. The matching `ReactRoute` sets `router = true`. See `routerCore.ts` for what it does,
     * and when it leaves navigating to the browser.
     *
     * An app with a `_shell.tsx` next to its `_layout.tsx` has that shell imported into its router entry, to be rendered
     * around every page and kept mounted between them (see `ReactRoute.router`).
     *
     * Pass an object to also configure the router (every option here becomes an argument of the generated
     * `startRouter()` call, so it can't be a function — see `useNavigationEffects()` for those): `appDirs` picks the
     * apps, as the array form does.
     *
     * Default: no router; pages hydrate independently and every navigation loads a whole document.
     */
    router?: boolean | string[] | RouterViteOptions;

    /**
     * Additional Vite plugins to include (e.g. `@tailwindcss/vite`, `vite-plugin-svgr`).
     * These are appended after the built-in React and hydration plugins.
     */
    plugins?: any[];
}

/** The router settings `createViteConfig({ router: { ... } })` builds into each app's router entry. */
export interface RouterEntryOptions {
    /** Pages to prefetch when the browser is idle after the page has loaded (never when the user asked to save data), as links' `href`s. */
    prefetch?: {
        idle?: string[];
        /** Fetch their data too, not only their code. Default `false`. */
        data?: boolean;
        /** Also warm the page of any plain link when it is pointed at, pressed on or focused (a `Link` always does). Default `false`. */
        links?: boolean;
    };
    /** A CSS selector for the element focus moves to after a navigation, or `false` to leave focus alone. Default: the app's root. */
    focus?: string | false;
    /** How the page scrolls after a navigation: `"top"` (default), `"preserve"`, or `false` for not at all. */
    scroll?: "top" | "preserve" | false;
    /** Mark the root `data-router-pending` and `aria-busy` while a navigation is in flight. */
    pendingAttributes?: boolean;
}

/** `createViteConfig({ router })` as an object: which apps get a router, and how it's set up. */
export interface RouterViteOptions extends RouterEntryOptions {
    /** The `appDir`s that get a router. Default: all of them. */
    appDirs?: string[];
}

const VIRTUAL_PREFIX = "\0rapidrest-entry:";
const ROUTER_PREFIX = "\0rapidrest-router:";

/**
 * Scans `appDir` and returns a rollup input map for all page entry points, matching
 * `ReactRoute.resolveAppFile()`'s convention at any nesting depth (see `scanAppDirPages()`
 * for the exact convention).
 */
function findPageEntries(appDir: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const relPath of scanAppDirPages(appDir)) {
        const key = path.posix.join(appDir.replace(/\\/g, "/"), relPath);
        result[key] = VIRTUAL_PREFIX + key;
    }
    return result;
}

/**
 * The source of an app's router entry: a route table of the app's pages, each loaded by a dynamic import (so each becomes
 * its own chunk), handed to `startRouter()`.
 *
 * Where two files serve one route — `pets.tsx` and `pets/index.tsx` — the plain file wins, as it does when the server
 * resolves the URL.
 */
export function routerEntrySource(
    appDir: string,
    pages: string[] = scanAppDirPages(appDir),
    options: RouterEntryOptions = {},
): string {
    const byTemplate = new Map<string, string>();
    // (`pages` is in directory-scan order, which differs between filesystems — so both orders of a plain file and its
    // `index` twin are handled.)
    for (const relPath of pages) {
        const template = fileToRouteTemplate(relPath);
        const existing = byTemplate.get(template);
        if (!existing || (existing.endsWith("/index.tsx") && !relPath.endsWith("/index.tsx"))) {
            byTemplate.set(template, relPath);
        }
    }
    const routes = [...byTemplate].map(([template, relPath]) => {
        const absPath = path.resolve(appDir, relPath).replace(/\\/g, "/");
        return `    { template: ${JSON.stringify(template)}, load: () => import(${JSON.stringify(absPath)}) },`;
    });
    // The app's shell is imported statically, so that it's in the entry (a shell is rendered on every page, from the
    // first paint) rather than loaded on demand as a page is.
    const shell = findAppDirShell(appDir);
    const effects = {
        ...(options.focus !== undefined ? { focus: options.focus } : {}),
        ...(options.scroll !== undefined ? { scroll: options.scroll } : {}),
    };
    const settings = [
        ...(shell ? ["shell: Shell"] : []),
        ...(Object.keys(effects).length > 0 ? [`effects: ${JSON.stringify(effects)}`] : []),
        ...(options.pendingAttributes ? ["pendingAttributes: true"] : []),
        ...(options.prefetch ? [`prefetch: ${JSON.stringify(options.prefetch)}`] : []),
    ];
    return [
        `import { startRouter } from "@rapidrest/react/client";`,
        ...(shell ? [`import Shell from ${JSON.stringify(shell.replace(/\\/g, "/"))};`] : []),
        `startRouter([`,
        ...routes,
        settings.length > 0 ? `], { ${settings.join(", ")} });` : `]);`,
    ].join("\n");
}

/**
 * Vite plugin that auto-discovers page entry points from one or more `appDir`s and generates
 * virtual hydration entry modules for each — no hand-written `*.entry.tsx` files needed.
 *
 * Each virtual module (prefixed `\0`) calls `hydrateRoute(DefaultExport)`.
 * Vite treats `\0`-prefixed IDs as virtual (no real facadeModuleId), so it falls back
 * to `chunk.name` — the rollup input key — as the manifest key. This makes
 * `clientEntryKey = "app/pets.tsx"` resolve correctly in ReactRoute.
 *
 * A single plugin instance handles every `appDir` — `resolveId()`/`load()` decode the full
 * source path straight out of the virtual id itself, with no dependency on which `appDir` it
 * came from, so merging multiple apps only changes what `options()` discovers, not how the
 * resulting virtual modules resolve or load.
 */
function rapidRestHydrationPlugin(appDirs: string[], routerAppDirs: string[] = [], routerOptions: RouterEntryOptions = {}) {
    // Vite (rolldown) pre-fills `opts.input` with this resolved (and, for this framework, always
    // nonexistent) path whenever the project doesn't configure an explicit entry, before options()
    // ever runs. Captured via configResolved() so options() can drop exactly that placeholder -
    // everything else the caller (or another plugin) puts in `opts.input` is preserved verbatim.
    let defaultHtmlEntry: string | undefined;

    return {
        name: "rapidrest-hydration",

        configResolved(config: any) {
            defaultHtmlEntry = path.resolve(config.root, "index.html");
        },

        options(opts: any) {
            const entries: Record<string, string> = {};
            for (const appDir of appDirs) {
                // Every page gets its hydration entry, router or not. Under the router nothing loads them (the router
                // entry hydrates whichever page it finds itself on), but each one is a record in the manifest naming the
                // stylesheets and chunks its page needs — which is how the server knows what to put in the page's HTML.
                Object.assign(entries, findPageEntries(appDir));
                if (routerAppDirs.includes(appDir)) {
                    const key = path.posix.join(appDir.replace(/\\/g, "/"), ROUTER_ENTRY_NAME);
                    entries[key] = ROUTER_PREFIX + appDir;
                }
            }
            if (Object.keys(entries).length === 0) return null;

            const isDefaultPlaceholder = (f: string) => f === defaultHtmlEntry;

            let existing: Record<string, string> = {};
            if (typeof opts.input === "string") {
                if (!isDefaultPlaceholder(opts.input)) existing = { [opts.input]: opts.input };
            } else if (Array.isArray(opts.input)) {
                existing = Object.fromEntries(
                    opts.input.filter((f: string) => !isDefaultPlaceholder(f)).map((f: string) => [f, f]),
                );
            } else if (opts.input) {
                existing = Object.fromEntries(
                    Object.entries(opts.input as Record<string, string>).filter(
                        ([, f]) => !isDefaultPlaceholder(f),
                    ),
                );
            }

            return { ...opts, input: { ...existing, ...entries } };
        },

        resolveId(id: string) {
            if (id.startsWith(VIRTUAL_PREFIX) || id.startsWith(ROUTER_PREFIX)) return id;
        },

        load(id: string) {
            if (id.startsWith(ROUTER_PREFIX)) return routerEntrySource(id.slice(ROUTER_PREFIX.length), undefined, routerOptions);
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
 * // Multiple apps in one project — one build/manifest covering both
 * export default createViteConfig({ appDir: ["apps/www", "apps/admin"] });
 *
 * @example
 * // With Tailwind CSS
 * import tailwindcss from "@tailwindcss/vite";
 * export default createViteConfig({ appDir: "app", plugins: [tailwindcss()] });
 */
export async function createViteConfig(options: RapidRestViteOptions = {}) {
    const { defineConfig } = await import("vite");
    const { default: react } = await import("@vitejs/plugin-react");

    const { appDir = "app", outDir = "dist/public", router = false, plugins: userPlugins = [] } = options;
    const appDirs = Array.isArray(appDir) ? appDir : [appDir];
    let routerAppDirs: string[] = [];
    let routerOptions: RouterEntryOptions = {};
    if (router === true) routerAppDirs = appDirs;
    else if (Array.isArray(router)) routerAppDirs = router;
    else if (router) {
        const { appDirs: routed, ...settings } = router;
        routerAppDirs = routed ?? appDirs;
        routerOptions = settings;
    }

    return defineConfig({
        plugins: [react(), rapidRestHydrationPlugin(appDirs, routerAppDirs, routerOptions), ...userPlugins],
        build: {
            outDir,
            manifest: true,
            emptyOutDir: true,
        },
    });
}
