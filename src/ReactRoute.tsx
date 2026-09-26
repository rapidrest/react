///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import crypto from "crypto";
import { EventEmitter } from "events";
import fs from "fs";
import { register } from "module";
import path from "path";
import { pathToFileURL } from "url";
import { HttpRequest, HttpResponse, ObjectFactory, RouteDecorators } from "@rapidrest/service-core";
import React, { ComponentType, PropsWithChildren } from "react";
import { renderToString } from "react-dom/server";
import { ObjectDecorators, RedisStore } from "@rapidrest/core";
import { fileToRouteTemplate, scanAppDirPages } from "./appDirScan.js";
import { RouterProvider } from "./routerContext.js";
import { NAVIGATION_HEADER, ROUTER_CONFIG_ID, ROUTER_ENTRY_NAME, type RouterConfig } from "./routerCore.js";
import {
    fillRouteTemplate,
    parseDynamicSegmentName,
    STATIC_EXPORT_ENV_VAR,
    STATIC_PATHS_ROUTE,
} from "./routeMatch.js";

const { Config, Init, Inject, Logger } = ObjectDecorators;
const { ContentType, Get, Request, Response } = RouteDecorators;

// Makes a page/layout module's static `import "*.css"` (the documented pattern for getting a
// stylesheet into a client entry's Vite manifest — see `callResolveClientUrls` below) safe to
// load via plain `import()` for SSR — see `ssrAssetLoaderHooks.ts`'s own doc comment for why this
// is otherwise a hard crash. Runs once per process, the moment this module is first imported
// (well before any request-time `renderPage()` call), regardless of how many `ReactRoute`
// subclasses exist.
//
// `register()`'s specifier is resolved by Node's own module resolution, not by whatever
// transformer (tsx/Vitest) is currently running this file — it does not understand the
// TypeScript/NodeNext convention of a `.js`-suffixed specifier referring to a sibling `.ts`
// source file. Running from source (`this file is still `ReactRoute.tsx`), only
// `ssrAssetLoaderHooks.ts` exists on disk; running compiled (`ReactRoute.js` in `dist/lib`),
// only the compiled `ssrAssetLoaderHooks.js` does — mirrors `resolveAppFile`'s own
// `hasTsxContext` detection below for the identical dev-vs-compiled distinction.
//
// The ternary's two branches can never both execute in the same process — this module *is*
// either `ReactRoute.tsx` or the compiled `ReactRoute.js`, decided once at build time, not
// per-call — so unlike `hasTsxContext` (a runtime check re-evaluated per `resolveAppFile()` call
// that tests can toggle via `process.argv`/env vars) there is no way to exercise the untaken
// branch from a test importing this module in only one of those two forms.
/* v8 ignore next -- see comment above: the untaken half of this branch requires a second process running the compiled dist */
register(import.meta.url.endsWith(".tsx") ? "./ssrAssetLoaderHooks.ts" : "./ssrAssetLoaderHooks.js", import.meta.url);

/** Whether a decoded URL segment is safe to use as a single literal file or directory name. */
function isSafeFileName(name: string): boolean {
    return !/[\/\\\0]/.test(name);
}

/**
 * The key a `@ReactService` is registered and looked up by: its path with empty segments collapsed (`/pets/` is `/pets`)
 * and each `:name` token reduced to `:`, so a service is the one of the page whose route template it matches by
 * position (`/pets/:petId` serves `pets/[id].tsx`), whatever the params are called.
 */
function serviceKey(template: string): string {
    return "/" + template.split("/").filter(Boolean).map((part) => (part.startsWith(":") ? ":" : part)).join("/");
}

/**
 * The text of the first `<title>` in `html`, as a browser would read it, or `undefined` when there isn't one. React
 * escapes `& < > " '` in text, and separates adjacent text nodes with `<!-- -->`.
 */
function extractTitle(html: string): string | undefined {
    const match = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i.exec(html);
    if (!match) return undefined;
    const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'", "#39": "'" };
    return match[1].replace(/<!--[\s\S]*?-->/g, "").replace(/&(amp|lt|gt|quot|#x27|#39);/g, (_, name: string) => entities[name]);
}

/** A directory's entries, listed once (see `ReactRoute.listDir()`). */
interface DirListing {
    entries: fs.Dirent[];
    names: Set<string>;
}

// Static SSE event bus shared across all ReactRoute instances in the process.
const _devReloadEmitter = new EventEmitter();
_devReloadEmitter.setMaxListeners(200);

/** How many times, and how far apart, to look for the manifest again after a rebuild replaced it (see `watchManifest()`). */
const MANIFEST_REWATCH_ATTEMPTS = 150;
/** How many times to look for a manifest that doesn't exist yet when the server starts (the first build is still running). */
const MANIFEST_FIRST_ATTEMPTS = 300;
const MANIFEST_REWATCH_DELAY_MS = 200;

const CACHE_BASE_KEY = "react.cache";
const DEV_RELOAD_PATH = "/__rapidrest__/reload";

/** MIME types for serving built hydration assets (JS bundles, CSS, source maps, fonts, images). */
const ASSET_MIME_TYPES: Record<string, string> = {
    ".css": "text/css",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".json": "application/json",
    ".map": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".jfif": "image/jpeg",
};

interface CacheEntry {
    hash: string;
}

/** One record of Vite's `manifest.json`, as far as this needs to read it. */
interface ManifestChunk {
    file: string;
    css?: string[];
    imports?: string[];
    name?: string;
}

type Manifest = Record<string, ManifestChunk>;

/** What resolving a URL against the app directory gives: the page file, and the route it is. */
export interface ResolvedAppFile {
    file: string;
    /** The values the URL's dynamic (`[name]`) segments captured. */
    params: Record<string, string>;
    /** The page's route template, e.g. `/pets/:id`, relative to the mount prefix. */
    template: string;
}

/**
 * Base class for HTTP routes that serve React pages from the `app/` directory.
 *
 * Convention-based page routing:
 *  - `app/_layout.tsx` — global HTML wrapper (loaded once, required)
 *  - `app/_404.tsx`    — 404 error page (optional)
 *  - `app/_500.tsx`    — 500 error page (optional)
 *  - `app/pets.tsx`    — serves GET /pets
 *  - `app/pets/index.tsx` — also serves GET /pets (index convention)
 *  - `app/pets/[id].tsx` or `app/pets/[id]/index.tsx` — serves GET /pets/:id; the captured value
 *    is available as `req.params.id` (in `fetchProps`) and `props.params.id` (on the component)
 *  - `app/_styles/`   — CSS assets (imported by layout or page components)
 *  - Any other non-`_`-prefixed `.tsx` file, at any depth, is a page — colocate a shared/helper
 *    component under an `_`-prefixed file or directory name to keep it from becoming a route
 *
 * Each page file exports:
 *  - `default`         — React component (required)
 *  - `fetchProps`      — async function (req) → props object (optional)
 *  - `getStaticPaths`  — async function () → array of `{ [param]: string }` objects, one per
 *    concrete instance of a dynamic route this page should statically export (optional; a
 *    `@ReactService` matching the same dynamic route may also implement `getStaticPaths()` for
 *    DI-backed enumeration — see `exportStaticSite()` in `static.ts`)
 *
 * Subclass to inject DI services into `fetchProps`:
 * ```ts
 * @Route("/*")
 * export class AppRouter extends ReactRoute {
 *     @Inject(PetService) private pets: PetService;
 *     protected async fetchProps(req) { return { pets: await this.pets.findAll() }; }
 * }
 * ```
 *
 * @author Jean-Philippe Steinmetz
 */
export class ReactRoute {
    // The decorator's emitted `design:type` metadata ternary falls back to `Object` only when
    // `Redis` is unresolved at decoration time (e.g. a circular import); since it's a real,
    // always-successfully-imported class here, that fallback branch is structurally unreachable.
    /* v8 ignore start */
    @Inject(RedisStore, { args: [CACHE_BASE_KEY] })
    protected cache?: RedisStore;
    /* v8 ignore stop */

    /** Filesystem path to the app directory, relative to cwd. Default is `app`. */
    protected readonly appDir: string = "app";

    /** Cache TTL in seconds. Caching is only active in production (`NODE_ENV=production`). */
    protected readonly cacheTTL: number = 60;

    /** Opt-in client-side hydration. When true, wraps the page in a hydration root and injects the client bundle. */
    protected readonly hydrate: boolean = false;

    /**
     * Opt-in client-side navigation. When true, the pages of this app hydrate under a router that, on a click on a link
     * to another of the app's pages, fetches that page's props as JSON (the same props the server would have rendered it
     * with) and swaps the page in, instead of loading a whole new document. Implies `hydrate`, and needs the client
     * bundle built with `createViteConfig({ router: true })`.
     *
     * The router only ever *enhances* rendering the page on the server, which it never replaces: every page is still
     * served as complete HTML at its own URL (so it works with JavaScript off, for crawlers, and as the first load),
     * and whenever the client isn't sure it can navigate faithfully — an unknown route, a redirect, an error page, any
     * failure — the browser simply loads the URL the ordinary way. See `routerCore.ts`.
     */
    protected readonly router: boolean = false;

    /**
     * Allow-list of `req.user` field names exposed as `props.user`. Default `null` means no
     * `user` object is exposed to pages or the hydration payload — only the scalar `userUid` is
     * passed. Opt in per-subclass, e.g. `protected readonly userFields = ["uid", "email"];`.
     */
    protected readonly userFields: string[] | null = null;

    /** DOM element id for the React hydration root. */
    protected readonly hydrateRootId: string = "react-root";

    /** DOM element id for the serialized props `<script>` tag. */
    protected readonly hydratePropsId: string = "react-props";

    /** Hard cap on concurrent dev-reload SSE connections per route instance. */
    protected readonly maxDevReloadConnections: number = 100;

    private devReloadConnectionCount = 0;

    /**
     * Path to Vite's manifest.json for resolving content-hashed bundle URLs.
     * Required when `hydrate = true` in production. Configure via nconf `react:manifestPath`.
     */
    @Config("react:manifestPath", "")
    private manifestPath: string = "";

    /**
     * The global layout component, if `_layout.tsx` exists. Receives the same merged `props` object
     * (page `fetchProps` + `@ReactService.fetchProps` + this route's own `fetchProps` override) as the
     * page component it wraps, alongside `children` — see the main `renderPage()` render call site. A
     * layout that only destructures `{ children }` is unaffected by this; it's an additive capability,
     * not a breaking one. Not extended to the `_500` fallback render (below): `props` there may never
     * have been computed at all if a `fetchProps` call is what threw in the first place.
     */
    private layout: ComponentType<PropsWithChildren<Record<string, any>>> | null = null;

    /**
     * Caches the framework's own `_layout`/`_404`/`_500` lookups (production only — the app dir's file set is fixed once
     * built; dev mode always re-resolves so newly added/removed files are picked up immediately). Only those, of which
     * there are three per app: a cache keyed by the requested URL grows with every distinct one an anonymous client makes up.
     */
    private resolvedFileCache: Map<string, ResolvedAppFile | null> = new Map();

    /**
     * Production only: the entries of each directory of the app that a page lookup has listed. The set of directories is
     * the app's own tree — only ones that exist are ever listed — so this is bounded by it, however many URLs are asked for.
     */
    private dirListings: Map<string, DirListing> = new Map();

    /** Production only: the client assets of each page, found in the manifest once (see `memoizeAssets()`). */
    private assetMemo: Map<string, any> = new Map();

    /**
     * In-flight render promises keyed by cache key, so concurrent requests for the same cold
     * cache entry share one render instead of each independently re-rendering (cache stampede).
     */
    private pendingRenders: Map<string, Promise<{ status: number; html: string }>> = new Map();

    /** ...and the same for the JSON a client navigation is answered with. */
    private pendingNavigations: Map<string, Promise<{ status: number; json: string }>> = new Map();

    @Logger
    protected logger: any;

    /**
     * In production the manifest is loaded once at @Init.
     * In development it is re-read from disk on every request so fresh bundle URLs
     * are used immediately after `vite build --watch` finishes a rebuild.
     */
    private manifest: Record<string, { file: string; css?: string[]; name?: string }> | null = null;

    // Same structurally-unreachable design:type fallback as cacheClient above — ObjectFactory is
    // always a real, successfully-imported class here.
    /* v8 ignore start */
    @Inject(ObjectFactory)
    private objectFactory?: ObjectFactory;
    /* v8 ignore stop */

    /**
     * The URL prefix derived from `@Route` metadata at init time.
     * E.g. `@Route("/app/*")` → prefix = "/app". Used to strip the prefix from req.path
     * before resolving app page files, and to scope the dev-reload SSE endpoint.
     */
    private routePrefix: string = "";

    /**
     * The `@ReactService` instances to use when fetching props during page rendering, by `serviceKey()` of their path:
     * a page's service is the one registered for its route template (`/pets`, `/pets/:id`), not one found by matching
     * the URL, so a URL a page's params captured (`/admin%2fstats`) can never reach another page's service.
     */
    private services: Map<string, any> = new Map();

    @Init
    protected async init() {
        // Derive the route prefix from @Route metadata so page resolution is prefix-agnostic.
        // @Route("/app/*") → prefix "/app", @Route("/*") → prefix ""
        const routePaths: string[] = Reflect.getMetadata("rrst:routePaths", Object.getPrototypeOf(this)) || [];
        this.routePrefix = (routePaths[0] || "")
            .replace(/\/\*$/, "")   // strip trailing /*
            .replace(/\/$/, "");    // strip trailing /

        const manifestPath = this.manifestPath;

        // Production: load manifest once
        if (process.env.NODE_ENV === "production" && manifestPath) {
            try {
                this.manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
            } catch (err) {
                this.logger.warn(`[ReactRoute] Could not load Vite manifest at "${manifestPath}": ${err}`);
            }
        }

        // Dev: watch manifest file and signal connected browsers to reload after each build
        if (this.isDevMode() && manifestPath) {
            // If it doesn't exist yet — the first build hasn't run — there's no watcher; browser reload will still
            // happen via the server-restart SSE connection drop.
            // The first build may still be running (`rapidreact dev` starts it alongside the server), so keep looking.
            if (!this.watchManifest(manifestPath)) this.rewatchManifest(manifestPath, MANIFEST_FIRST_ATTEMPTS);
        }

        // Scan the class loader for all classes that have been marked with @ReactService.
        // Awaited, so the services are registered before the first request can be served (and cached without them).
        const registrations: Promise<{ paths: string[]; instance: any } | undefined>[] = [];
        this.objectFactory?.classes.forEach((clazz, name) => registrations.push((async () => {
            // Ignore all non-class types
            if (!clazz?.prototype) {
                return undefined;
            }

            let routePaths: string[] | undefined = Reflect.getMetadata("rrst:reactServicePaths", clazz.prototype);
            if (routePaths) {
                this.logger.debug(`Found react service. Name=${name}, Paths=${routePaths}`);
                // Instantiate the react service and register in the map for each path configured.
                const instance: any = await this.objectFactory?.newInstance(clazz, { name: "default" });
                if (instance) return { paths: routePaths, instance };
            }
            return undefined;
        })()));
        // Registered in the order the classes were listed, not the order they happened to finish instantiating in, so
        // which of two services claiming one page wins is the same every boot.
        for (const registered of await Promise.all(registrations)) {
            for (const rpath of registered?.paths ?? []) {
                // A service's path is the page's public URL, so this route only serves the ones under its own
                // prefix (whole segments: `/apple` isn't under `/app`); the rest belong to another mount.
                if (this.routePrefix && rpath !== this.routePrefix && !rpath.startsWith(this.routePrefix + "/")) {
                    continue;
                }
                this.services.set(serviceKey(rpath.slice(this.routePrefix.length) || "/"), registered!.instance);
            }
        }
    }

    /**
     * The request's query string with its leading `?` (or `""` when there is none). Some server adapters (uWS) leave the
     * query out of `req.url` and only provide it parsed as `req.query`, so it's rebuilt from that when `req.url` has none.
     */
    private requestSearch(req: any): string {
        const url: string = req.url ?? "";
        if (url.includes("?")) return url.slice(url.indexOf("?"));
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(req.query ?? {})) {
            for (const v of Array.isArray(value) ? value : [value]) params.append(key, String(v));
        }
        const search = params.toString();
        return search ? "?" + search : "";
    }

    /**
     * Resolves the `@ReactService` instance (if any) of a page, by the route template it was resolved to
     * (`/pets/:id`) — the service registered for that template, however its `:name` tokens are spelled. A service's
     * param names don't have to match the page's bracket names: `req.params` comes from the *page* resolver's capture,
     * which stays the single source of truth (though they should match, by convention, for `fetchProps` to make sense).
     * No page (the `_404` render) has no service.
     */
    private resolveService(template: string): any {
        return template ? this.services.get(serviceKey(template)) : undefined;
    }

    /**
     * Produces a stable, key-order-independent representation of req.query for cache-key hashing.
     * Sorting only the top-level keys (not array element order) avoids new collisions between
     * semantically different multi-value query strings while eliminating key-order nondeterminism.
     */
    protected canonicalizeQuery(query: Record<string, string | string[]> | undefined): Record<string, string | string[]> {
        if (!query) return {};
        // Object.create(null) avoids the Object.prototype "__proto__" accessor: on a plain object
        // literal, `sorted["__proto__"] = value` doesn't create an own property (it's silently
        // dropped for non-object values, or reassigns sorted's prototype for object values), which
        // would let a `?__proto__=...` query param vanish from the hash below and collide two
        // otherwise-distinct requests onto the same cache key.
        const sorted: Record<string, string | string[]> = Object.create(null);
        for (const key of Object.keys(query).sort()) {
            sorted[key] = query[key];
        }
        return sorted;
    }

    /**
     * Override to fold additional request dimensions (e.g. `Accept-Language`, a feature-flag
     * cookie) into the cache key, for pages whose rendered output varies on something beyond
     * path/params/query/user identity. Returns {} by default (no extra dimensions).
     */
    protected cacheKeyExtras(_req: HttpRequest): Record<string, any> {
        return {};
    }

    /**
     * Computes a stable per-request cache key (MD5 of the app, path + params + query + user identity). The app
     * (`appDir` and mount prefix) is part of it so two apps sharing one cache can't answer each other's URLs, and under
     * the router so is the query string as written, since the page renders the location it was asked for.
     */
    protected hashRequest(req: HttpRequest): string {
        const key = "static." + JSON.stringify({
            app: this.appDir,
            prefix: this.routePrefix,
            path: req.path,
            params: req.params,
            query: this.canonicalizeQuery(req.query),
            search: this.router ? this.requestSearch(req) : undefined,
            userUid: req.user?.uid,
            ...this.cacheKeyExtras(req),
        });
        return crypto.createHash("md5").update(key).digest("hex");
    }

    /** Pending "reload" notification, so a burst of change events from one build produces a single reload. */
    private manifestReloadTimer: ReturnType<typeof setTimeout> | null = null;

    private scheduleReload(): void {
        if (this.manifestReloadTimer) clearTimeout(this.manifestReloadTimer);
        this.manifestReloadTimer = setTimeout(() => {
            _devReloadEmitter.emit("reload");
            this.manifestReloadTimer = null;
        }, 150);
    }

    /**
     * Dev only: watches the Vite manifest and tells connected browsers to reload after each build. Returns whether a
     * watcher was established (`false` when the manifest doesn't exist).
     *
     * A build *replaces* the manifest rather than editing it in place, and what a watcher does about that depends on
     * the platform: on Windows it emits an `'error'` event (`EPERM`) — which, with nothing listening, Node treats as
     * fatal, taking the whole dev server down with it, and leaving it down until the next file change — while
     * elsewhere it quietly keeps watching the file that no longer exists, deaf to every later build. So both an
     * `'error'` and a `'rename'` (the file was replaced) end the watch and look for the new file (see
     * `rewatchManifest()`).
     */
    private watchManifest(manifestPath: string): boolean {
        try {
            const watcher = fs.watch(manifestPath, { persistent: false }, (event) => {
                this.scheduleReload();
                if (event === "rename") {
                    watcher.close();
                    this.rewatchManifest(manifestPath);
                }
            });
            watcher.on("error", () => {
                watcher.close();
                this.rewatchManifest(manifestPath);
            });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Watches the manifest again once a rebuild has put it back. The build deletes it before writing the new one, so it
     * may not be there yet: keeps looking for a few seconds (unref'd, so it never holds the process open), and reloads
     * the browsers as soon as it's found, since the build that replaced it has finished by then.
     */
    private rewatchManifest(manifestPath: string, attemptsLeft: number = MANIFEST_REWATCH_ATTEMPTS): void {
        if (this.watchManifest(manifestPath)) {
            this.scheduleReload();
            return;
        }
        if (attemptsLeft > 1) {
            setTimeout(() => this.rewatchManifest(manifestPath, attemptsLeft - 1), MANIFEST_REWATCH_DELAY_MS).unref();
        }
    }

    /**
     * Whether dev-only behaviors (live-reload SSE endpoint, reload script injection, manifest
     * file-watching) are enabled. Explicit allow-list rather than `!== "production"` so an unset
     * or misconfigured NODE_ENV in a real deployment fails closed (dev features OFF) instead of
     * failing open. Override in a subclass to opt a non-standard environment name into dev mode.
     */
    protected isDevMode(): boolean {
        const env = process.env.NODE_ENV;
        return env === "development" || env === "test" || !!process.env.VITEST || !!process.env.JEST_WORKER_ID;
    }

    /**
     * Resolve a file in the app directory for a URL path segment (e.g. `/pets` or `/pets/123`),
     * walking one path component at a time. At each directory level a literal name match wins;
     * only on a literal miss does a `[name]`-bracketed sibling (a dynamic-segment directory or, at
     * the final segment, a leaf file) get tried, capturing the URL value into `params`. There is no
     * backtracking: once a literal directory is entered at a level, a subsequent resolution failure
     * fails outright rather than retrying a sibling bracket at that level.
     *
     * At the final segment, tries `.tsx` → `/index.tsx` → `.jsx` → `/index.jsx` → `.js` →
     * `/index.js` (dev) or `.js` → `/index.js` (production) in order, same as before — this ordering
     * is now also applied to a bracket-name candidate, treating it exactly like a literal segment.
     *
     * A file or directory whose name starts with `_` is never a route, so no URL resolves to one: `/_layout` and
     * `/_components/Button` are as unmatched as any other missing page (a `[dynamic]` sibling can still capture the
     * value). `internal` is for the framework's own lookups of `_layout`, `_404` and `_500`, which are exactly those
     * files: it matches the literal name only, never a `[dynamic]` sibling.
     */
    protected async resolveAppFile(
        appDir: string,
        segment: string,
        internal: boolean = false
    ): Promise<ResolvedAppFile | null> {
        const isProduction = process.env.NODE_ENV === "production";
        const cacheKey = `${appDir} ${segment}`;
        if (isProduction && internal) {
            const cached = this.resolvedFileCache.get(cacheKey);
            if (cached !== undefined) return cached;
        }

        // Sanitize every path component before any filesystem access — independent of, and in
        // addition to, the walk's own structural safety (it can only ever descend into a real
        // `readdir()`-returned name or a sanitized literal), this guards both the segments used to
        // build paths and the values captured into `params`.
        const parts: string[] = [];
        let malformed = false;
        for (const rawPart of segment.split("/")) {
            if (!rawPart) continue;
            let part: string;
            try {
                part = decodeURIComponent(rawPart);
            } catch {
                malformed = true;
                break;
            }
            if (part === "." || part === "..") {
                malformed = true;
                break;
            }
            parts.push(part);
        }

        if (malformed) return null;

        // Detect whether we're running under a TypeScript transformer (tsx/ts-node),
        // or a test runner that transforms TS/JSX itself (Vitest, Jest). In either case
        // .tsx page files can be loaded directly. Otherwise (compiled .js entry with a
        // plain node runtime), only .js files are safe to import — look in appDir then
        // dist/appDir. We can't rely on NODE_ENV here — it's not guaranteed to be set to
        // "production" for every plain-node deployment, and test runners set it inconsistently.
        const mainEntry = process.argv[1] ?? "";
        const hasTsxContext =
            mainEntry.endsWith(".ts") ||
            mainEntry.endsWith(".tsx") ||
            process.env.VITEST === "true" ||
            !!process.env.JEST_WORKER_ID;

        const suffixes = hasTsxContext
            ? [".tsx", "/index.tsx", ".jsx", "/index.jsx", ".js", "/index.js"]
            : [".js", "/index.js"];

        const result = !hasTsxContext
            ? (await this.walkAppDir(appDir, parts, suffixes, internal)) ??
              (await this.walkAppDir(path.join("dist", appDir), parts, suffixes, internal))
            // In dev (tsx) all TypeScript extensions are handled natively.
            : await this.walkAppDir(appDir, parts, suffixes, internal);

        if (isProduction && internal) this.resolvedFileCache.set(cacheKey, result);
        return result;
    }

    /** `fs.promises.access(F_OK)` as a boolean, swallowing the not-found/EACCES error. */
    private async fileExists(p: string): Promise<boolean> {
        try {
            await fs.promises.access(p, fs.constants.F_OK);
            return true;
        } catch {
            return false;
        }
    }

    /** Whether `p` exists and is a directory, false (never throws) otherwise. */
    private async isDirectory(p: string): Promise<boolean> {
        try {
            return (await fs.promises.stat(p)).isDirectory();
        } catch {
            return false;
        }
    }

    /**
     * Lists `dir` (`null` when it can't be read), by the names it really has. A literal URL segment is matched against
     * these rather than by asking the filesystem for the path, which a case-insensitive one (Windows, macOS) answers for
     * any casing: `/PeTs` would resolve to `pets.tsx`, each casing a different module to Node's import cache, and
     * the router's template would be built from the URL and not match any page. In production the listing is remembered.
     */
    private async listDir(dir: string): Promise<DirListing | null> {
        const cached = this.dirListings.get(dir);
        if (cached) return cached;
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            return null;
        }
        const listing = { entries, names: new Set(entries.map((entry) => entry.name)) };
        if (process.env.NODE_ENV === "production") this.dirListings.set(dir, listing);
        return listing;
    }

    /**
     * Scans a directory's entries (`dir` is only named in the warning) for `[name]`-bracketed dynamic-segment candidates
     * and returns the winning name,
     * or `null` if there are none. Bracket directories are always considered; bracket-named files
     * matching one of `fileExts` are additionally considered when `fileExts` is non-null (only
     * meaningful at the final path segment — intermediate segments must be directories). On
     * ambiguity (more than one distinct bracket name at this level — a developer misconfiguration,
     * e.g. sibling `[id]`/`[slug]`), logs a warning on every call (this is a static
     * misconfiguration that reproduces on every matching request, worth surfacing repeatedly) and
     * deterministically picks the lexicographically-smallest name.
     */
    private findDynamicSegmentName(dir: string, entries: fs.Dirent[], fileExts: string[] | null): string | null {
        const names = new Set<string>();
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const name = parseDynamicSegmentName(entry.name);
                if (name) names.add(name);
            } else if (fileExts && entry.isFile()) {
                for (const ext of fileExts) {
                    if (entry.name.endsWith(ext)) {
                        const name = parseDynamicSegmentName(entry.name.slice(0, -ext.length));
                        if (name) names.add(name);
                        break;
                    }
                }
            }
        }

        if (names.size === 0) return null;
        const sorted = [...names].sort();
        if (sorted.length > 1) {
            this.logger.warn(
                `[ReactRoute] Ambiguous dynamic route segments in "${dir}": ` +
                `${sorted.map((n) => `[${n}]`).join(", ")}. Using "[${sorted[0]}]".`
            );
        }
        return sorted[0];
    }

    /**
     * Resolves `parts` (URL path components, already sanitized) against the filesystem rooted at
     * `root`, trying `suffixes` (in order) at the final segment — see `resolveAppFile()`'s doc
     * comment for the full matching/precedence semantics.
     */
    private async walkAppDir(
        root: string,
        parts: string[],
        suffixes: string[],
        internal: boolean
    ): Promise<ResolvedAppFile | null> {
        const appRoot = path.resolve(process.cwd(), root);

        if (parts.length === 0) {
            for (const suffix of suffixes) {
                const full = appRoot + suffix;
                if (await this.fileExists(full)) return { file: full, params: {}, template: "/" };
            }
            return null;
        }

        const params: Record<string, string> = {};
        // What the client router matches on is the route of the *file* — `/index` and `/pets/index` are `/` and `/pets` —
        // never the URL's own spelling.
        const templateOf = (file: string) => fileToRouteTemplate(path.relative(appRoot, file).replace(/\\/g, "/"));
        let currentDir = appRoot;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isLast = i === parts.length - 1;

            // A decoded segment holding a path separator or NUL (`..%2f..%2fx`) can only ever be a value
            // captured into a `[dynamic]` param — never a literal name to probe on disk. Neither can a `_`-prefixed
            // one (those files aren't routes), except for the framework's own `internal` lookups of them.
            const literalOk = isSafeFileName(part) && (internal || !part.startsWith("_"));

            const listing = await this.listDir(currentDir);
            if (!listing) return null;

            if (!isLast) {
                const literalDir = path.join(currentDir, part);
                if (literalOk && listing.names.has(part) && (await this.isDirectory(literalDir))) {
                    currentDir = literalDir;
                    continue;
                }
                const bracketName = this.findDynamicSegmentName(currentDir, listing.entries, null);
                if (!bracketName) return null;
                params[bracketName] = part;
                currentDir = path.join(currentDir, `[${bracketName}]`);
                continue;
            }

            for (const suffix of literalOk ? suffixes : []) {
                // The name the directory has to have: the file itself, or the directory that holds its `/index`.
                if (!listing.names.has(suffix.startsWith("/") ? part : part + suffix)) continue;
                const full = path.join(currentDir, part) + suffix;
                if (await this.fileExists(full)) return { file: full, params, template: templateOf(full) };
            }

            if (internal) return null;

            const fileExts = suffixes.filter((s) => !s.startsWith("/"));
            const bracketName = this.findDynamicSegmentName(currentDir, listing.entries, fileExts);
            if (!bracketName) return null;
            const bracketParams = { ...params, [bracketName]: part };
            for (const suffix of suffixes) {
                const full = path.join(currentDir, `[${bracketName}]`) + suffix;
                if (await this.fileExists(full)) {
                    return { file: full, params: bracketParams, template: templateOf(full) };
                }
            }
            return null;
        }

        /* v8 ignore next -- unreachable: the loop always returns on its last (isLast) iteration */
        return null;
    }

    /**
     * Computes the props a page is rendered with: its own `fetchProps`, a matching `@ReactService`'s, and this route's own
     * override, fetched concurrently (they're independent data sources) and merged in that order of precedence, on top
     * of the identity of the user and the dynamic-segment captures. Used both to render the page on the server and to
     * answer a client navigation with the very same props, so the two can never disagree.
     */
    private async buildProps(
        req: HttpRequest,
        template: string,
        mod: any,
        dynamicParams: Record<string, string>
    ): Promise<any> {
        const pageFetchProps: ((req: HttpRequest) => Promise<any>) | undefined = mod.fetchProps;

        // Check to see if there's a react service for this page
        const service: any = this.resolveService(template);

        // There are three levels of fetching props: Page => Service => Route. These are
        // independent data sources — fetch them concurrently rather than one at a time.
        const [pageProps, serviceProps, routePropsRaw] = await Promise.all([
            pageFetchProps ? pageFetchProps(req) : Promise.resolve({}),
            service ? service.fetchProps(req) : Promise.resolve({}),
            this.fetchProps(req),
        ]);
        const routeProps = routePropsRaw ?? {};
        const exposedUser = this.pickUserFields(req.user);
        return {
            userUid: req.user?.uid,
            ...(exposedUser !== undefined ? { user: exposedUser } : {}),
            params: dynamicParams,
            ...pageProps,
            ...serviceProps,
            ...routeProps,
        };
    }

    /** Lazy-loads the global layout, on the first request that needs it. */
    private async ensureLayout(): Promise<void> {
        if (this.layout) return;
        const layoutResolved = await this.resolveAppFile(this.appDir, "_layout", true);
        if (layoutResolved) {
            const layoutMod = await import(pathToFileURL(layoutResolved.file).href);
            this.layout = layoutMod.default;
        }
    }

    /**
     * The `<title>` the layout renders for a page's props, for a client navigation (the browser doesn't render the
     * layout again, so the title would otherwise stay the first page's). `undefined` when there's no layout or it has no
     * title; a layout that fails to render costs the navigation its title, not the navigation.
     */
    private async renderTitle(props: any): Promise<string | undefined> {
        try {
            await this.ensureLayout();
            const Layout = this.layout;
            return Layout ? extractTitle(renderToString(<Layout {...props}>{null}</Layout>)) : undefined;
        } catch (err) {
            this.logger.warn(`[ReactRoute] Could not render the layout's title for a navigation:`, err);
            return undefined;
        }
    }

    /**
     * Renders a page for the given request: resolves the layout/page file, fetches props,
     * runs SSR (falling back to `_404`/`_500` as needed), and injects the dev-reload script.
     * Factored out of `get()` so concurrent requests for the same cache key can share one
     * in-flight render (see the `pendingRenders` coalescing in `get()`) instead of each
     * independently repeating this work.
     */
    private async renderPage(req: HttpRequest, pageSegment: string): Promise<{ status: number; html: string }> {
        // Resolve page file — fall back to _404 when path has no matching file
        const resolved = await this.resolveAppFile(this.appDir, pageSegment);
        let pagePath = resolved?.file ?? null;
        const dynamicParams = resolved?.params ?? {};
        const template = resolved?.template ?? "";
        let httpStatus = 200;
        if (!pagePath) {
            pagePath = (await this.resolveAppFile(this.appDir, "_404", true))?.file ?? null;
            httpStatus = 404;
        }

        if (!pagePath) {
            return { status: 404, html: "<html><head></head><body><h1>404 Not Found</h1></body></html>" };
        }

        // Dynamic-segment captures become visible both to req.params (so fetchProps overrides —
        // page, service, route — can read them the same way any other RapidREST route would) and
        // to the page component's props (below) — merged, not overwritten, since req.params is
        // always {} coming in from the "/*" wildcard mount today, but a future non-wildcard mount
        // could set it first.
        req.params = { ...req.params, ...dynamicParams };

        let html: string;
        try {
            // Inside the try: a layout that fails to load is a page that fails to render (it gets `_500`, and its
            // error reported the same way), not an error nothing catches.
            await this.ensureLayout();
            const mod = await import(pathToFileURL(pagePath).href);
            const PageComponent = mod.default;
            const props = await this.buildProps(req, template, mod, dynamicParams);

            // `_404`/`_500` fallback pages are deliberately excluded from Vite's page-entry
            // scan (see findPageEntries in vite.ts), so they have no hydration bundle to inject —
            // only hydrate a genuinely-matched page (httpStatus === 200).
            const shouldHydrate = (this.hydrate || this.router) && httpStatus === 200;
            const Layout = this.layout;
            const pageElement = <PageComponent {...props} />;
            // Under the router the page renders inside the same `RouterProvider` the browser hydrates it in, so that
            // anything reading the location (a nav highlighting the current link) renders identically on both sides.
            const routed = this.router ? (
                <RouterProvider
                    location={{
                        pathname: req.path,
                        search: this.requestSearch(req),
                        params: dynamicParams,
                        route: template,
                    }}
                >
                    {pageElement}
                </RouterProvider>
            ) : pageElement;
            const content = shouldHydrate ? <div id={this.hydrateRootId}>{routed}</div> : pageElement;

            html = renderToString(Layout ? <Layout {...props}>{content}</Layout> : content);

            if (shouldHydrate) {
                html = this.router
                    ? this.injectRouterAssets(html, props, pagePath, template)
                    : this.injectHydrationAssets(html, props, pagePath);
            }
        } catch (err) {
            this.logger.error(`[ReactRoute] SSR error for "${req.path}":`, err);
            httpStatus = 500;

            // Never forward the raw Error to the client outside development (an unset or unusual NODE_ENV counts as
            // production, as for every other dev-only behaviour) — message/stack may
            // contain file paths or internal details. Full detail still reaches the log above.
            const safeErr = this.isDevMode()
                ? err
                : { name: "Error", message: "Internal Server Error" };

            const errorResolved = await this.resolveAppFile(this.appDir, "_500", true);
            if (errorResolved) {
                try {
                    const errMod = await import(pathToFileURL(errorResolved.file).href);
                    const ErrorPage = errMod.default;
                    const Layout = this.layout;
                    html = renderToString(
                        Layout
                            ? <Layout><ErrorPage error={safeErr} /></Layout>
                            : <ErrorPage error={safeErr} />
                    );
                } catch {
                    html = "<html><head></head><body><h1>500 Internal Server Error</h1></body></html>";
                }
            } else {
                html = "<html><head></head><body><h1>500 Internal Server Error</h1></body></html>";
            }
        }

        // Inject dev live-reload script
        if (this.isDevMode()) {
            html = this.injectDevReloadScript(html);
        }

        return { status: httpStatus, html };
    }

    @Get("/*")
    @ContentType("text/html")
    public async get(@Request req: HttpRequest, @Response res: HttpResponse) {
        // Strip the route prefix (e.g. "/app" from "/app/pets" → "/pets") so the page
        // file resolution is independent of where the route is mounted.
        const pageSegment = this.routePrefix && req.path.startsWith(this.routePrefix)
            ? req.path.slice(this.routePrefix.length) || "/"
            : req.path;

        // Built hydration bundles (e.g. "/assets/app/pets.tsx-abc123.js") live under Vite's
        // outDir, at the same mount point as the pages themselves. Serve them directly here
        // rather than falling through to page resolution, which would 404 → render `_404`,
        // which itself has no hydration entry (see below) and would throw.
        if (await this.tryServeAsset(pageSegment, res)) {
            return res;
        }

        // Dev SSE live-reload stream — held at <prefix>/__rapidrest__/reload
        if (this.isDevMode() && pageSegment === DEV_RELOAD_PATH) {
            this.handleDevReload(res);
            return;
        }

        // Static-path enumeration, used by exportStaticSite() to discover concrete instances of
        // this app's dynamic routes — only reachable while a dedicated static-export crawl is in
        // progress (see STATIC_EXPORT_ENV_VAR's doc comment for why this must never be always-on).
        if (process.env[STATIC_EXPORT_ENV_VAR] === "true" && pageSegment === STATIC_PATHS_ROUTE) {
            await this.handleStaticPaths(res);
            return res;
        }

        // The same URL is answered with HTML or, to the client router asking for a page's data, JSON: a cache in
        // between must keep the two apart.
        if (this.router) {
            this.appendVary(res);
            if (req.headers?.[NAVIGATION_HEADER.toLowerCase()] === "1") {
                return this.handleNavigation(req, res, pageSegment);
            }
        }

        const cacheClient = process.env.NODE_ENV === "production" ? this.cache : undefined;
        const cacheKey = cacheClient ? this.hashRequest(req) : null;

        // Production cache lookup. A read failure is treated as a cache miss (fall through to
        // rendering) rather than an uncaught exception — the SSR error path below already has
        // careful prod-safe redaction, and we don't want a transient cache-backend blip to skip
        // that and surface a raw error instead of a page.
        if (cacheClient && cacheKey) {
            try {
                const cached = await cacheClient.load(cacheKey);
                if (cached) {
                    return cached.html;
                }
            } catch (err) {
                this.logger.warn(`[ReactRoute] Cache read failed for "${req.path}":`, err);
            }
        }

        this.logger.debug(`[ReactRoute] Rendering "${pageSegment}"`);

        // Share a single in-flight render across concurrent requests for the same cache key,
        // instead of letting each one independently render on a cold cache (stampede). Only the
        // "leader" that actually created the render — not the followers that just awaited it —
        // writes the result through to cache, so coalesced requests don't all redundantly SETEX
        // the same value.
        let result: { status: number; html: string };
        let isLeader = false;
        const pending = cacheKey ? this.pendingRenders.get(cacheKey) : undefined;
        if (pending) {
            result = await pending;
        } else {
            isLeader = true;
            const renderPromise = this.renderPage(req, pageSegment);
            if (cacheKey) this.pendingRenders.set(cacheKey, renderPromise);
            try {
                result = await renderPromise;
            } finally {
                if (cacheKey) this.pendingRenders.delete(cacheKey);
            }
        }

        // For non-200 responses, send the response ourselves so the status code is preserved.
        // The RapidREST middleware wrapper always applies status 200 to return values, so we
        // bypass it by calling res.send() directly and returning res.
        if (result.status !== 200) {
            return this.sendHtml(res, result.status, result.html);
        }

        // Production-only cache (don't cache non-200). Fire-and-forget, but never unhandled —
        // a cache-backend error here must not crash requests that otherwise rendered fine.
        // Promise.resolve() also tolerates cache client stubs/mocks that don't return a promise.
        if (isLeader && cacheClient && cacheKey) {
            Promise.resolve(cacheClient.save(cacheKey, { html: result.html }, this.cacheTTL)).catch((err) => {
                this.logger.warn(`[ReactRoute] Failed to write cache for "${req.path}":`, err);
            });
        }

        return result.html;
    }

    // uWS registers the inherited `get()` handler's "/*" sub-path as the literal wildcard pattern
    // "/app/*", which only matches paths starting with "/app/" — the bare "/app" (no trailing
    // slash) doesn't match and falls through to a 404. Register that exact path too.
    @Get()
    @ContentType("text/html")
    public async getIndex(@Request req: HttpRequest, @Response res: HttpResponse) {
        return this.get(req, res);
    }

    /**
     * Answers a client-router navigation request: the page's props as JSON — what `renderPage()` would have rendered it
     * with — instead of its HTML, along with the stylesheets it needs. Anything but a page that resolves and computes
     * its props (no such page, an error) is answered with the status alone, which tells the client to have the browser
     * load the URL the ordinary way, so it's the server that renders the error page, exactly as it always did.
     */
    private async handleNavigation(req: HttpRequest, res: HttpResponse, pageSegment: string): Promise<HttpResponse> {
        const cacheClient = process.env.NODE_ENV === "production" ? this.cache : undefined;
        const cacheKey = cacheClient ? this.hashRequest(req) + ".navigation" : null;

        if (cacheClient && cacheKey) {
            try {
                const cached = await cacheClient.load(cacheKey);
                if (cached?.json) return this.sendJson(res, 200, cached.json);
            } catch (err) {
                this.logger.warn(`[ReactRoute] Cache read failed for "${req.path}":`, err);
            }
        }

        // One in-flight computation per key, as for the HTML: a page many browsers prefetch at once is worked out once.
        let result: { status: number; json: string };
        let isLeader = false;
        const pending = cacheKey ? this.pendingNavigations.get(cacheKey) : undefined;
        if (pending) {
            result = await pending;
        } else {
            isLeader = true;
            const computing = this.renderNavigation(req, pageSegment);
            if (cacheKey) this.pendingNavigations.set(cacheKey, computing);
            try {
                result = await computing;
            } finally {
                if (cacheKey) this.pendingNavigations.delete(cacheKey);
            }
        }
        if (isLeader && result.status === 200 && cacheClient && cacheKey) {
            Promise.resolve(cacheClient.save(cacheKey, { json: result.json }, this.cacheTTL)).catch((err) => {
                this.logger.warn(`[ReactRoute] Failed to write cache for "${req.path}":`, err);
            });
        }
        return this.sendJson(res, result.status, result.json);
    }

    private async renderNavigation(req: HttpRequest, pageSegment: string): Promise<{ status: number; json: string }> {
        const resolved = await this.resolveAppFile(this.appDir, pageSegment);
        if (!resolved) return { status: 404, json: JSON.stringify({ status: 404 }) };

        req.params = { ...req.params, ...resolved.params };
        try {
            const mod = await import(pathToFileURL(resolved.file).href);
            const props = await this.buildProps(req, resolved.template, mod, resolved.params);
            const { css } = this.resolveRouterAssets(resolved.file);
            const title = await this.renderTitle(props);
            return { status: 200, json: JSON.stringify({ route: resolved.template, props, css, ...(title !== undefined ? { title } : {}) }) };
        } catch (err) {
            this.logger.error(`[ReactRoute] Error computing props for navigation to "${req.path}":`, err);
            return { status: 500, json: JSON.stringify({ status: 500 }) };
        }
    }

    /** Adds the navigation header to the response's `Vary`, keeping what an earlier middleware (CORS's `Origin`) put there. */
    private appendVary(res: HttpResponse): void {
        const existing = String((res as any).getHeader?.("Vary") ?? "");
        const listed = existing.split(",").map((value) => value.trim().toLowerCase());
        if (listed.includes(NAVIGATION_HEADER.toLowerCase())) return;
        (res as any).setHeader?.("Vary", existing.trim() ? `${existing}, ${NAVIGATION_HEADER}` : NAVIGATION_HEADER);
    }

    /** Sends a JSON response with the given status code, bypassing the middleware wrapper. */
    private sendJson(res: HttpResponse, status: number, json: string): HttpResponse {
        (res as any).status?.(status);
        (res as any).setHeader?.("content-type", "application/json");
        this.appendVary(res);
        (res as any).setHeader?.("X-Content-Type-Options", "nosniff");
        (res as any).send?.(json);
        return res;
    }

    /** Sends an HTML response with the given status code, bypassing the middleware wrapper. */
    private sendHtml(res: HttpResponse, status: number, html: string): HttpResponse {
        (res as any).status?.(status);
        (res as any).setHeader?.("content-type", "text/html");
        (res as any).send?.(html);
        return res;
    }

    /**
     * Picks the `userFields` allow-list out of `user`. Returns `undefined` (meaning: don't expose
     * a `user` prop at all) when there's no user or no allow-list configured.
     */
    protected pickUserFields(user: any): Record<string, any> | undefined {
        if (!user || !this.userFields) return undefined;
        const picked: Record<string, any> = {};
        for (const field of this.userFields) {
            if (field in user) picked[field] = user[field];
        }
        return picked;
    }

    /**
     * Returns additional props merged into the page component props.
     * Override in subclasses to provide DI-injected server-side data.
     * Page-file `fetchProps` runs first; this override runs after and takes precedence.
     */
    protected async fetchProps(_req: HttpRequest): Promise<any> {
        return {};
    }

    // --- Dev live-reload ---

    private handleDevReload(res: HttpResponse): void {
        if (this.devReloadConnectionCount >= this.maxDevReloadConnections) {
            (res as any).status?.(503);
            (res as any).send?.("");
            return;
        }

        // The counter and the `_devReloadEmitter` listener registered below can only ever be
        // cleaned up from inside the onAbort callback — without it there's no disconnect signal
        // at all, and both would leak permanently (eventually locking out real clients once the
        // phantom count reaches maxDevReloadConnections, and piling up listeners on the shared,
        // process-global emitter). Decline to track the connection rather than leak it.
        const onAbort = (res as any).onAbort;
        if (typeof onAbort !== "function") {
            this.logger.warn(
                "[ReactRoute] Response does not support onAbort; declining dev live-reload connection to avoid a resource leak."
            );
            (res as any).status?.(501);
            (res as any).send?.("");
            return;
        }

        this.devReloadConnectionCount++;

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Access-Control-Allow-Origin", "*");
        // Flush headers immediately — SSE requires the response to stay open.
        // flushHeaders/write are provided by UWSResponse for streaming support.
        (res as any).flushHeaders?.();
        (res as any).write?.(": connected\n\n");

        const onReload = () => (res as any).write?.("data: reload\n\n");
        _devReloadEmitter.on("reload", onReload);
        // onAbort fans out alongside the existing _aborted tracking in UWSResponse.
        onAbort.call(res, () => {
            _devReloadEmitter.off("reload", onReload);
            this.devReloadConnectionCount--;
        });
        // Do NOT call res.end() — the SSE stream stays open.
    }

    // --- Static path enumeration (export) ---

    /**
     * Computes, for every dynamic route template discovered under `appDir`, the concrete path
     * instances the app can enumerate — via a page's own exported `getStaticPaths()` and/or the
     * matching `@ReactService`'s `getStaticPaths()` method (DI-backed, e.g. querying a database
     * for every valid id). Both are optional; a template with neither is simply absent from the
     * response, meaning `exportStaticSite()` cannot include it and reports it as un-enumerable
     * instead. Results from page and service are unioned (deduped) rather than one taking
     * precedence — either is a valid way to declare an instance exists.
     *
     * Sends `{ [template: string]: string[] }` as the response body — always JSON, regardless of
     * the class-level `@ContentType("text/html")` on `get()`, since this bypasses that wrapper
     * (see the call site in `get()`, which returns `res` directly like `tryServeAsset()` does).
     */
    private async handleStaticPaths(res: HttpResponse): Promise<void> {
        const templates = new Map<string, string>(); // template -> its (first-found) relative page file
        for (const relPath of scanAppDirPages(this.appDir)) {
            const template = fileToRouteTemplate(relPath);
            if (template.includes(":") && !templates.has(template)) {
                templates.set(template, relPath);
            }
        }

        const result: Record<string, string[]> = {};
        for (const [template, relPath] of templates) {
            const paths = new Set<string>();
            const addEntries = (entries: Record<string, string>[] | null | undefined) => {
                for (const params of entries ?? []) {
                    const filled = fillRouteTemplate(template, params);
                    if (filled) paths.add(filled);
                }
            };

            try {
                const filePath = path.resolve(process.cwd(), this.appDir, relPath);
                const mod = await import(pathToFileURL(filePath).href);
                if (typeof mod.getStaticPaths === "function") {
                    addEntries(await mod.getStaticPaths());
                }
            } catch (err) {
                this.logger.warn(`[ReactRoute] getStaticPaths() failed for page "${relPath}":`, err);
            }

            const service = this.services.get(serviceKey(template));
            if (service && typeof service.getStaticPaths === "function") {
                try {
                    addEntries(await service.getStaticPaths());
                } catch (err) {
                    this.logger.warn(
                        `[ReactRoute] getStaticPaths() failed for the @ReactService matching "${template}":`, err
                    );
                }
            }

            if (paths.size > 0) result[template] = [...paths];
        }

        (res as any).setHeader?.("content-type", "application/json");
        (res as any).send?.(JSON.stringify(result));
    }

    // --- Static asset serving ---

    /**
     * Derives Vite's `outDir` from the configured manifest path. Vite always writes the
     * manifest to `<outDir>/.vite/manifest.json`, so this is `manifestPath` with that
     * trailing segment stripped. Returns `null` when hydration/manifest isn't configured.
     */
    private resolveOutDir(): string | null {
        if (!this.manifestPath) return null;
        return path.dirname(path.dirname(this.manifestPath));
    }

    /**
     * Serves a built hydration asset (e.g. `/assets/app/pets.tsx-abc123.js`, referenced by
     * `injectHydrationAssets`) directly from Vite's output directory, bypassing SSR/page
     * resolution entirely. Returns `true` if the request was handled. Never serves from outside the output
     * directory, nor from a dot folder inside it (`.vite/manifest.json`) other than `.well-known`.
     */
    private async tryServeAsset(pageSegment: string, res: HttpResponse): Promise<boolean> {
        const outDir = this.resolveOutDir();
        if (!outDir) return false;

        // Most requests are for pages: only a path with a file extension we serve is worth touching the filesystem for.
        const mimeType = ASSET_MIME_TYPES[path.extname(pageSegment)];
        if (!mimeType) return false;

        const root = path.resolve(process.cwd(), outDir);
        const filePath = path.resolve(root, pageSegment.replace(/^\//, ""));
        // Reject any path that escapes the output directory (e.g. via `../` segments).
        if (filePath !== root && !filePath.startsWith(root + path.sep)) return false;

        let stat: fs.Stats;
        try {
            stat = await fs.promises.stat(filePath);
        } catch {
            return false;
        }
        if (!stat.isFile()) return false;

        // Nor is anything in a dot folder or a dotfile part of the site: Vite writes its manifest to `.vite/`, which
        // lists every source entry. (`.well-known/` is the one place the web puts files on purpose.) Judged by where the
        // file really is, so neither a symlink out of the output directory nor a name the filesystem has another
        // spelling of (Windows' 8.3 short names: `.vite` is also `VITE~1`) gets round it.
        let realFile: string;
        let realRoot: string;
        try {
            [realFile, realRoot] = await Promise.all([fs.promises.realpath(filePath), fs.promises.realpath(root)]);
        } catch {
            return false;
        }
        if (!realFile.startsWith(realRoot + path.sep)) return false;
        if (path.relative(realRoot, realFile).split(path.sep).some((part) => part.startsWith(".") && part !== ".well-known")) {
            return false;
        }

        const data = await fs.promises.readFile(filePath);
        (res as any).setHeader?.("content-type", mimeType);
        // A file Vite named for its content (`index-BvT3x9_a.js`) can never change: browsers and CDNs may keep it for good.
        if (/-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/.test(path.basename(filePath))) {
            (res as any).setHeader?.("cache-control", "public, max-age=31536000, immutable");
        }
        (res as any).send?.(data);
        return true;
    }

    private injectDevReloadScript(html: string): string {
        const sseUrl = this.routePrefix + DEV_RELOAD_PATH;
        const script = `<script>(function(){` +
            `var e=new EventSource('${sseUrl}');` +
            `e.onmessage=function(m){if(m.data==='reload')location.reload();};` +
            `e.onerror=function(){e.close();` +
            `(function p(){fetch('/').then(function(){location.reload();})` +
            `.catch(function(){setTimeout(p,800);});})();};` +
            `})();</script>`;
        if (html.includes("</body>")) return html.replace("</body>", () => script + "</body>");
        if (html.includes("</html>")) return html.replace("</html>", () => script + "</html>");
        return html + script;
    }

    // --- Hydration ---

    private resolveManifest(): Record<string, { file: string; css?: string[]; name?: string }> | null {
        if (process.env.NODE_ENV === "production") return this.manifest;
        const manifestPath = this.manifestPath;
        if (!manifestPath) return null;
        try {
            return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        } catch {
            return null;
        }
    }

    /** `p` relative to the working directory with forward slashes, e.g. `./apps/www` or an absolute path → `apps/www`. */
    private static toCwdRelativePosix(p: string): string {
        return path.relative(process.cwd(), path.resolve(process.cwd(), p)).replace(/\\/g, "/");
    }

    /**
     * The source directory a compiled `appDir` mirrors: `appDir` with its last `dist` path segment removed
     * (`dist/apps/www` → `apps/www`, `node_modules/pkg/dist/apps/www` → `node_modules/pkg/apps/www`). Returns
     * `null` when `appDir` has no `dist` segment followed by at least one more segment.
     */
    private static stripDistSegment(appDir: string): string | null {
        const parts = appDir.split("/");
        const index = parts.lastIndexOf("dist");
        if (index < 0 || index === parts.length - 1) return null;
        parts.splice(index, 1);
        return parts.join("/");
    }

    /**
     * Finds the manifest record of a page's hydration entry. Each page has one (its virtual entry module, built as a
     * Vite input of its own — also under the router, where it exists only so the manifest says which stylesheets and
     * chunks the page needs), keyed by the entry's input name rather than its source path, which a shared chunk can
     * swallow.
     */
    private findPageEntry(pagePath: string): { manifest: Manifest; entry: ManifestChunk } {
        const manifest = this.resolveManifest();
        if (manifest) {
            const relPath = path.relative(process.cwd(), pagePath).replace(/\\/g, "/");
            // Vite derives the top-level manifest key from the entry chunk's facadeModuleId
            // (relative-to-root, with null bytes stripped) rather than the rollup input key.
            // The virtual hydration modules created by createViteConfig()'s plugin, that key
            // ends up prefixed (e.g. "rapidrest-entry:app/pets.tsx") instead of matching
            // `entryKey` directly. Each manifest entry's own `name` field, however, is always
            // the original input key, so fall back to a value search on that field.
            //
            // In production, `pagePath` is the *compiled* `<outDir>/**/*.js` module actually
            // executed for SSR (see `renderPage()`'s `import()`), not the original
            // `apps/**/*.{tsx,jsx}` source file the manifest's `name` field is derived from
            // (e.g. ".../dist/apps/www/index.js" vs "apps/www/index.tsx"). Re-anchor at
            // `this.appDir` — present verbatim in both forms — and compare extension-stripped so a
            // compiled path can still be matched against its source-relative entry.
            const stripExt = (p: string) => p.replace(/\.[^./]+$/, "");
            const appDir = ReactRoute.toCwdRelativePosix(this.appDir);
            const anchorIndex = relPath.indexOf(appDir);
            const entryKey = stripExt(anchorIndex >= 0 ? relPath.slice(anchorIndex) : relPath);
            const entryKeys = [entryKey];
            // An `appDir` can itself point at a compiled mirror of the sources Vite built from — e.g. a
            // package's `node_modules/<pkg>/dist/apps/www`, whose sources (and so manifest names) are
            // `node_modules/<pkg>/apps/www/**`. Anchoring at `appDir` alone then never matches, so also
            // try the sibling source directory with the `dist` segment removed.
            const sourceAppDir = ReactRoute.stripDistSegment(appDir);
            if (sourceAppDir && entryKey.startsWith(appDir + "/")) {
                entryKeys.push(sourceAppDir + entryKey.slice(appDir.length));
            }
            // Rollup/Vite sanitizes characters that aren't safe in a generated chunk name — including
            // `[`/`]` from a dynamic route segment's filename, e.g. `[id].tsx` — replacing them with `_`
            // when deriving a manifest entry's `name` field from the (virtual) input key. A dynamic-route
            // page's `entryKey` is built from the literal, unsanitized source path, so `app/pets/[id].tsx`
            // must also be compared against its sanitized form (`app/pets/_id_`) — otherwise no dynamic
            // page's entry is ever found by name, and every `hydrate=true` dynamic page throws here on
            // every request.
            const findByName = (key: string) =>
                Object.values(manifest).find((candidate) => candidate.name && stripExt(candidate.name) === key);
            // The entry's own record first: a page module that's also loaded some other way (dynamically, by the router)
            // is a chunk of its own, keyed by its source path — a record of the page itself, not of its entry.
            let entry: ManifestChunk | undefined;
            for (const key of entryKeys) {
                entry = entry ?? findByName(key) ?? findByName(key.replace(/[[\]]/g, "_"));
            }
            entry = entry ?? manifest[relPath];
            if (entry) {
                return { manifest, entry };
            }
            this.logger.warn(
                `[ReactRoute] Manifest entry "${relPath}" not found. ` +
                `Available keys: ${Object.keys(manifest).join(", ")}`
            );
        }
        throw new Error(
            `[ReactRoute] ${this.router ? "router=true" : "hydrate=true"} requires react.manifestPath to be configured ` +
            `and a matching Vite manifest entry for "${pagePath}".`
        );
    }

    /**
     * Everything `chunk` needs: the stylesheets of it and of every chunk it imports, and the files of those imported
     * chunks. A stylesheet imported by a *shared* component (e.g. a layout/shell component several pages import)
     * doesn't end up in the entry chunk's own `css` array — Vite hoists CSS shared across multiple entries into whichever
     * intermediate chunk actually contains the import (visible in the manifest via that chunk's own `imports`/`css`
     * fields), not onto every entry that transitively pulls it in. Reading only `chunk.css` therefore silently drops any
     * stylesheet imported from a non-entry module in the graph — this walks `imports` (deduping against cycles shared
     * chunks can create) to collect every chunk's `css`, matching how the built HTML is actually assembled by
     * Vite/Rollup.
     */
    private static collectChunkAssets(manifest: Manifest, chunk: ManifestChunk): { css: string[]; files: string[] } {
        const seenChunks = new Set<string>();
        const walk = (current: ManifestChunk): { css: string[]; files: string[] } => {
            const css = [...(current.css ?? [])];
            const files: string[] = [];
            for (const importKey of current.imports ?? []) {
                if (seenChunks.has(importKey)) {
                    continue;
                }
                seenChunks.add(importKey);
                const imported = manifest[importKey];
                if (imported) {
                    const nested = walk(imported);
                    css.push(...nested.css);
                    files.push(imported.file, ...nested.files);
                }
            }
            return { css, files };
        };
        return walk(chunk);
    }

    /**
     * In production the manifest is fixed, so what it says about a page is worked out once: finding an entry searches the
     * whole manifest, which every render and every navigation would otherwise repeat. (Only a page that has an entry is
     * remembered; a page without one throws every time.)
     */
    private memoizeAssets<T>(key: string, compute: () => T): T {
        if (process.env.NODE_ENV !== "production" || !this.manifest) return compute();
        if (!this.assetMemo.has(key)) this.assetMemo.set(key, compute());
        return this.assetMemo.get(key);
    }

    private resolveClientUrls(pagePath: string): { js: string; css: string[] } {
        return this.memoizeAssets(`client ${pagePath}`, () => {
            const { manifest, entry } = this.findPageEntry(pagePath);
            return {
                js: `/${entry.file}`,
                css: [...new Set(ReactRoute.collectChunkAssets(manifest, entry).css)].map((f) => `/${f}`),
            };
        });
    }

    /**
     * Escapes a JSON string for safe embedding inside an inline <script> element. Replacing every
     * `<` (not just the literal substring "</script>") blocks the full HTML end-tag-open grammar
     * (`</script` followed by whitespace, `/`, or `>`), which a substring match on "</script>" alone
     * does not. JSON.stringify never emits a bare `<` outside of string content, so this is safe
     * and `JSON.parse` treats `<` identically to `<`, so it round-trips losslessly.
     */
    protected escapeForInlineScript(json: string): string {
        return json.replace(/</g, "\\u003c");
    }

    /**
     * The client assets for a page under the router: the app's router entry (which hydrates whichever page it finds
     * itself on, and takes over navigating from there), the stylesheets that page needs, and hints to fetch its chunks now
     * rather than after the router entry has run. The page's own stylesheets and chunks come from its hydration entry's
     * record in the manifest (see findPageEntry()); the router entry is the one built for the app's `appDir`.
     */
    private resolveRouterAssets(pagePath: string): { entry: string; css: string[]; preload: string[] } {
        return this.memoizeAssets(`router ${pagePath}`, () => this.findRouterAssets(pagePath));
    }

    private findRouterAssets(pagePath: string): { entry: string; css: string[]; preload: string[] } {
        const { manifest, entry: pageEntry } = this.findPageEntry(pagePath);

        const appDir = ReactRoute.toCwdRelativePosix(this.appDir);
        // A compiled app (`dist/apps/www`) was built from the sources without `dist`, which is what its entries are named for.
        const sourceAppDir = ReactRoute.stripDistSegment(appDir);
        const entryNames = [appDir, ...(sourceAppDir ? [sourceAppDir] : [])].map((dir) => `${dir}/${ROUTER_ENTRY_NAME}`);
        const routerEntry = Object.values(manifest).find((candidate) => candidate.name && entryNames.includes(candidate.name));
        if (!routerEntry) {
            throw new Error(
                `[ReactRoute] router=true requires a Vite manifest entry for the router of "${appDir}" (${entryNames[0]}). ` +
                `Build the client with createViteConfig({ router: true }). Available keys: ${Object.keys(manifest).join(", ")}`
            );
        }

        const page = ReactRoute.collectChunkAssets(manifest, pageEntry);
        const router = ReactRoute.collectChunkAssets(manifest, routerEntry);
        const url = (f: string) => `/${f}`;
        return {
            entry: url(routerEntry.file),
            css: [...new Set([...(routerEntry.css ?? []), ...router.css, ...(pageEntry.css ?? []), ...page.css])].map(url),
            // What the page's chunks import that the router entry doesn't already load itself.
            preload: [...new Set(page.files)].filter((f) => f !== routerEntry.file && !router.files.includes(f)).map(url),
        };
    }

    private injectRouterAssets(html: string, props: any, pagePath: string, template: string): string {
        const { entry, css, preload } = this.resolveRouterAssets(pagePath);
        const config: RouterConfig = {
            prefix: this.routePrefix,
            route: template,
            rootId: this.hydrateRootId,
            propsId: this.hydratePropsId,
            css,
        };
        const configTag = `<script type="application/json" id="${ROUTER_CONFIG_ID}">${this.escapeForInlineScript(JSON.stringify(config))}</script>`;
        const propsTag = `<script type="application/json" id="${this.hydratePropsId}">${this.escapeForInlineScript(JSON.stringify(props))}</script>`;
        const headTags =
            css.map((href) => `<link rel="stylesheet" href="${href}">`).join("") +
            preload.map((href) => `<link rel="modulepreload" href="${href}">`).join("");
        const bodyTags = configTag + propsTag + `<script type="module" src="${entry}"></script>`;

        let result = html;
        if (result.includes("</head>")) {
            result = result.replace("</head>", () => headTags + "</head>");
        }
        if (result.includes("</body>")) return result.replace("</body>", () => bodyTags + "</body>");
        if (result.includes("</html>")) return result.replace("</html>", () => bodyTags + "</html>");
        return result + bodyTags;
    }

    private injectHydrationAssets(html: string, props: any, pagePath: string): string {
        const { js, css } = this.resolveClientUrls(pagePath);
        const safeProps = this.escapeForInlineScript(JSON.stringify(props ?? null));
        const propsTag = `<script type="application/json" id="${this.hydratePropsId}">${safeProps}</script>`;
        const cssLinks = css.map((href) => `<link rel="stylesheet" href="${href}">`).join("");
        const bundleTag = `<script type="module" src="${js}"></script>`;

        let result = html;
        if (cssLinks && result.includes("</head>")) {
            result = result.replace("</head>", () => cssLinks + "</head>");
        }
        const bodyInjection = propsTag + bundleTag;
        if (result.includes("</body>")) return result.replace("</body>", () => bodyInjection + "</body>");
        if (result.includes("</html>")) return result.replace("</html>", () => bodyInjection + "</html>");
        return result + bodyInjection;
    }
}
