///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import crypto from "crypto";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { DatabaseDecorators, HttpRequest, HttpResponse, ObjectFactory, RouteDecorators } from "@rapidrest/service-core";
import { Redis } from "ioredis";
import React, { ComponentType, PropsWithChildren } from "react";
import { renderToString } from "react-dom/server";
import { ObjectDecorators } from "@rapidrest/core";

const { RedisConnection } = DatabaseDecorators;
const { Config, Init, Inject, Logger } = ObjectDecorators;
const { ContentType, Get, Request, Response } = RouteDecorators;

const _hashCache: Map<string, string> = new Map();

// Static SSE event bus shared across all ReactRoute instances in the process.
const _devReloadEmitter = new EventEmitter();
_devReloadEmitter.setMaxListeners(200);

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
};

/**
 * Base class for HTTP routes that serve React pages from the `app/` directory.
 *
 * Convention-based page routing:
 *  - `app/layout.tsx` — global HTML wrapper (loaded once, required)
 *  - `app/_404.tsx`    — 404 error page (optional)
 *  - `app/_500.tsx`    — 500 error page (optional)
 *  - `app/pets.tsx`    — serves GET /pets
 *  - `app/pets/index.tsx` — also serves GET /pets (index convention)
 *  - `app/_styles/`   — CSS assets (imported by layout or page components)
 *
 * Each page file exports:
 *  - `default`         — React component (required)
 *  - `fetchProps`      — async function (req) → props object (optional)
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
    @RedisConnection("cache")
    protected cacheClient?: Redis;
    /* v8 ignore stop */

    /** Filesystem path to the app directory, relative to cwd. Default is `apps/app`. */
    protected readonly appDir: string = "apps/app";

    /** Cache TTL in seconds. Caching is only active in production (`NODE_ENV=production`). */
    protected readonly cacheTTL: number = 60;

    /** Opt-in client-side hydration. When true, wraps the page in a hydration root and injects the client bundle. */
    protected readonly hydrate: boolean = false;

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

    private layout: ComponentType<PropsWithChildren> | null = null;

    /**
     * Caches resolveAppFile() lookups (production only — the app dir's file set is fixed once
     * built, so repeat fs work per request is pure waste; dev mode always re-resolves so newly
     * added/removed page files are picked up immediately).
     */
    private resolvedFileCache: Map<string, string | null> = new Map();

    /**
     * In-flight render promises keyed by cache key, so concurrent requests for the same cold
     * cache entry share one render instead of each independently re-rendering (cache stampede).
     */
    private pendingRenders: Map<string, Promise<{ status: number; html: string }>> = new Map();

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
     * A map of paths to service class instances to use when fetching props during page rendering.
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
            let debounce: ReturnType<typeof setTimeout> | null = null;
            try {
                fs.watch(manifestPath, { persistent: false }, () => {
                    if (debounce) clearTimeout(debounce);
                    debounce = setTimeout(() => {
                        _devReloadEmitter.emit("reload");
                        debounce = null;
                    }, 150);
                });
            } catch {
                // Manifest doesn't exist yet — first build hasn't run. Watcher will be absent;
                // browser reload will still happen via server-restart SSE connection drop.
            }
        }

        // Scan the class loader for all classes that have been marked with @ReactService.
        this.objectFactory?.classes.forEach(async (clazz, name) => {
            // Ignore all non-class types
            if (!clazz?.prototype) {
                return;
            }

            let routePaths: string[] | undefined = Reflect.getMetadata("rrst:reactServicePaths", clazz.prototype);
            if (routePaths) {
                this.logger.debug(`Found react service. Name=${name}, Paths=${routePaths}`);
                // Instantiate the react service and register in the map for each path configured.
                const instance: any = await this.objectFactory?.newInstance(clazz, { name: "default" });
                if (instance) {
                    for (const rpath of routePaths) {
                        const pageSegment = this.routePrefix && rpath.startsWith(this.routePrefix)
                            ? rpath.slice(this.routePrefix.length) || "/"
                            : rpath;
                        this.services.set(pageSegment, instance);
                    }
                }
            }
        });
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
     * Computes a stable per-request cache key (MD5 of path + params + query + user identity).
     */
    protected hashRequest(req: HttpRequest): string {
        const key = "static." + JSON.stringify({
            path: req.path,
            params: req.params,
            query: this.canonicalizeQuery(req.query),
            userUid: req.user?.uid,
            ...this.cacheKeyExtras(req),
        });
        let hash = _hashCache.get(key);
        if (!hash) {
            hash = crypto.createHash("md5").update(key).digest("hex");
            if (_hashCache.size >= 10000) _hashCache.clear();
            _hashCache.set(key, hash);
        }
        return hash;
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
     * Resolve a file in the app directory by trying multiple extensions in order.
     * Tries .tsx → /index.tsx → .jsx → /index.jsx → .js → /index.js.
     * In dev mode tsx handles .tsx directly; in production tsc outputs .js.
     */
    protected async resolveAppFile(appDir: string, segment: string): Promise<string | null> {
        const isProduction = process.env.NODE_ENV === "production";
        const cacheKey = `${appDir} ${segment}`;
        if (isProduction) {
            const cached = this.resolvedFileCache.get(cacheKey);
            if (cached !== undefined) return cached;
        }

        const tryDir = async (dir: string, suffixes: string[]): Promise<string | null> => {
            const appRoot = path.resolve(process.cwd(), dir);
            const base = path.resolve(appRoot, segment.replace(/^\//, ""));
            if (base !== appRoot && !base.startsWith(appRoot + path.sep)) return null;
            for (const suffix of suffixes) {
                const full = base + suffix;
                try {
                    await fs.promises.access(full, fs.constants.F_OK);
                    return full;
                } catch {
                    // try the next suffix
                }
            }
            return null;
        };

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

        const result = !hasTsxContext
            ? (await tryDir(appDir, [".js", "/index.js"])) ??
              (await tryDir(path.join("dist", appDir), [".js", "/index.js"]))
            // In dev (tsx) all TypeScript extensions are handled natively.
            : await tryDir(appDir, [".tsx", "/index.tsx", ".jsx", "/index.jsx", ".js", "/index.js"]);

        if (isProduction) {
            this.resolvedFileCache.set(cacheKey, result);
        }
        return result;
    }

    /**
     * Renders a page for the given request: resolves the layout/page file, fetches props,
     * runs SSR (falling back to `_404`/`_500` as needed), and injects the dev-reload script.
     * Factored out of `get()` so concurrent requests for the same cache key can share one
     * in-flight render (see the `pendingRenders` coalescing in `get()`) instead of each
     * independently repeating this work.
     */
    private async renderPage(req: HttpRequest, pageSegment: string): Promise<{ status: number; html: string }> {
        // Lazy-load the global layout on first request
        if (!this.layout) {
            const layoutPath = await this.resolveAppFile(this.appDir, "_layout");
            if (layoutPath) {
                const layoutMod = await import(pathToFileURL(layoutPath).href);
                this.layout = layoutMod.default;
            }
        }

        // Resolve page file — fall back to _404 when path has no matching file
        let pagePath = await this.resolveAppFile(this.appDir, pageSegment);
        let httpStatus = 200;
        if (!pagePath) {
            pagePath = await this.resolveAppFile(this.appDir, "_404");
            httpStatus = 404;
        }

        if (!pagePath) {
            return { status: 404, html: "<html><head></head><body><h1>404 Not Found</h1></body></html>" };
        }

        let html: string;
        try {
            const mod = await import(pathToFileURL(pagePath).href);
            const PageComponent = mod.default;
            const pageFetchProps: ((req: HttpRequest) => Promise<any>) | undefined = mod.fetchProps;

            // Check to see if there's a react service for this page path
            const service: any = this.services.get(pageSegment);

            // There are three levels of fetching props: Page => Service => Route. These are
            // independent data sources — fetch them concurrently rather than one at a time.
            const [pageProps, serviceProps, routePropsRaw] = await Promise.all([
                pageFetchProps ? pageFetchProps(req) : Promise.resolve({}),
                service ? service.fetchProps(req) : Promise.resolve({}),
                this.fetchProps(req),
            ]);
            const routeProps = routePropsRaw ?? {};
            const exposedUser = this.pickUserFields(req.user);
            const props = {
                userUid: req.user?.uid,
                ...(exposedUser !== undefined ? { user: exposedUser } : {}),
                ...pageProps,
                ...serviceProps,
                ...routeProps,
            };

            // `_404`/`_500` fallback pages are deliberately excluded from Vite's page-entry
            // scan (see findPageEntries in vite.ts), so they have no hydration bundle to inject —
            // only hydrate a genuinely-matched page (httpStatus === 200).
            const shouldHydrate = this.hydrate && httpStatus === 200;
            const Layout = this.layout;
            const content = shouldHydrate
                ? <div id={this.hydrateRootId}><PageComponent {...props} /></div>
                : <PageComponent {...props} />;

            html = renderToString(Layout ? <Layout>{content}</Layout> : content);

            if (shouldHydrate) {
                html = this.injectHydrationAssets(html, props, pagePath);
            }
        } catch (err) {
            this.logger.error(`[ReactRoute] SSR error for "${req.path}":`, err);
            httpStatus = 500;

            // Never forward the raw Error to the client in production — message/stack may
            // contain file paths or internal details. Full detail still reaches the log above.
            const safeErr = process.env.NODE_ENV === "production"
                ? { name: "Error", message: "Internal Server Error" }
                : err;

            const errorPath = await this.resolveAppFile(this.appDir, "_500");
            if (errorPath) {
                try {
                    const errMod = await import(pathToFileURL(errorPath).href);
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

        const cacheClient = process.env.NODE_ENV === "production" ? this.cacheClient : undefined;
        const cacheKey = cacheClient ? this.hashRequest(req) : null;

        // Production cache lookup. A read failure is treated as a cache miss (fall through to
        // rendering) rather than an uncaught exception — the SSR error path below already has
        // careful prod-safe redaction, and we don't want a transient cache-backend blip to skip
        // that and surface a raw error instead of a page.
        if (cacheClient && cacheKey) {
            try {
                const cached = await cacheClient.get(cacheKey);
                if (cached) {
                    return cached;
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
            Promise.resolve(cacheClient.setex(cacheKey, this.cacheTTL, result.html)).catch((err) => {
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
     * resolution entirely. Returns `true` if the request was handled.
     */
    private async tryServeAsset(pageSegment: string, res: HttpResponse): Promise<boolean> {
        const outDir = this.resolveOutDir();
        if (!outDir) return false;

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

        const ext = path.extname(filePath);
        const mimeType = ASSET_MIME_TYPES[ext];
        if (!mimeType) return false;

        const data = await fs.promises.readFile(filePath);
        (res as any).setHeader?.("content-type", mimeType);
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
        if (html.includes("</body>")) return html.replace("</body>", script + "</body>");
        if (html.includes("</html>")) return html.replace("</html>", script + "</html>");
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

    private resolveClientUrls(pagePath: string): { js: string; css: string[] } {
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
            const anchorIndex = relPath.indexOf(this.appDir);
            const entryKey = stripExt(anchorIndex >= 0 ? relPath.slice(anchorIndex) : relPath);
            const entry =
                manifest[relPath] ??
                Object.values(manifest).find(
                    (candidate) => candidate.name && stripExt(candidate.name) === entryKey
                );
            if (entry) {
                return { js: `/${entry.file}`, css: (entry.css ?? []).map((f) => `/${f}`) };
            }
            this.logger.warn(
                `[ReactRoute] Manifest entry "${relPath}" not found. ` +
                `Available keys: ${Object.keys(manifest).join(", ")}`
            );
        }
        throw new Error(
            `[ReactRoute] hydrate=true requires react.manifestPath to be configured ` +
            `and a matching Vite manifest entry for "${pagePath}".`
        );
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

    private injectHydrationAssets(html: string, props: any, pagePath: string): string {
        const { js, css } = this.resolveClientUrls(pagePath);
        const safeProps = this.escapeForInlineScript(JSON.stringify(props ?? null));
        const propsTag = `<script type="application/json" id="${this.hydratePropsId}">${safeProps}</script>`;
        const cssLinks = css.map((href) => `<link rel="stylesheet" href="${href}">`).join("");
        const bundleTag = `<script type="module" src="${js}"></script>`;

        let result = html;
        if (cssLinks && result.includes("</head>")) {
            result = result.replace("</head>", cssLinks + "</head>");
        }
        const bodyInjection = propsTag + bundleTag;
        if (result.includes("</body>")) return result.replace("</body>", bodyInjection + "</body>");
        if (result.includes("</html>")) return result.replace("</html>", bodyInjection + "</html>");
        return result + bodyInjection;
    }
}
