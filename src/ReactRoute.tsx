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

/**
 * Resolve a file in the app directory by trying multiple extensions in order.
 * Tries .tsx → /index.tsx → .jsx → /index.jsx → .js → /index.js.
 * In dev mode tsx handles .tsx directly; in production tsc outputs .js.
 */
function resolveAppFile(appDir: string, segment: string): string | null {
    const base = path.resolve(process.cwd(), appDir, segment.replace(/^\//, ""));
    for (const suffix of [".tsx", "/index.tsx", ".jsx", "/index.jsx", ".js", "/index.js"]) {
        const full = base + suffix;
        if (fs.existsSync(full)) return full;
    }
    return null;
}

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
    @RedisConnection("cache")
    protected cacheClient?: Redis;

    /** Cache TTL in seconds. Caching is only active in production (`NODE_ENV=production`). */
    protected readonly cacheTTL: number = 60;

    /** Opt-in client-side hydration. When true, wraps the page in a hydration root and injects the client bundle. */
    protected readonly hydrate: boolean = false;

    /** DOM element id for the React hydration root. */
    protected readonly hydrateRootId: string = "react-root";

    /** DOM element id for the serialized props `<script>` tag. */
    protected readonly hydratePropsId: string = "react-props";

    /** Filesystem path to the app directory, relative to cwd. Configure via nconf `react:appDir`. */
    @Config("react:appDir", "app")
    private appDir: string = "app";

    /**
     * Path to Vite's manifest.json for resolving content-hashed bundle URLs.
     * Required when `hydrate = true` in production. Configure via nconf `react:manifestPath`.
     */
    @Config("react:manifestPath", "")
    private manifestPath: string = "";

    private layout: ComponentType<PropsWithChildren> | null = null;

    @Logger
    protected logger: any;

    /**
     * In production the manifest is loaded once at @Init.
     * In development it is re-read from disk on every request so fresh bundle URLs
     * are used immediately after `vite build --watch` finishes a rebuild.
     */
    private manifest: Record<string, { file: string; css?: string[] }> | null = null;

    @Inject(ObjectFactory)
    private objectFactory?: ObjectFactory;

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
        if (process.env.NODE_ENV !== "production" && manifestPath) {
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
     * Computes a stable per-request cache key (MD5 of path + params + user identity).
     */
    protected hashRequest(req: HttpRequest): string {
        const key = "static." + JSON.stringify({ path: req.path, params: req.params, userUid: req.user?.uid });
        let hash = _hashCache.get(key);
        if (!hash) {
            hash = crypto.createHash("md5").update(key).digest("hex");
            if (_hashCache.size >= 10000) _hashCache.clear();
            _hashCache.set(key, hash);
        }
        return hash;
    }

    @Get()
    @ContentType("text/html")
    public async get(@Request req: HttpRequest, @Response res: HttpResponse) {
        // Strip the route prefix (e.g. "/app" from "/app/pets" → "/pets") so the page
        // file resolution is independent of where the route is mounted.
        const pageSegment = this.routePrefix && req.path.startsWith(this.routePrefix)
            ? req.path.slice(this.routePrefix.length) || "/"
            : req.path;

        // Dev SSE live-reload stream — held at <prefix>/__rapidrest__/reload
        if (process.env.NODE_ENV !== "production" && pageSegment === DEV_RELOAD_PATH) {
            this.handleDevReload(res);
            return;
        }

        // Production cache lookup
        if (process.env.NODE_ENV === "production" && this.cacheClient) {
            const cached = await this.cacheClient.get(this.hashRequest(req));
            if (cached) {
                return cached;
            }
        }

        this.logger.debug(`[ReactRoute] Rendering "${pageSegment}"`);

        // Lazy-load the global layout on first request
        if (!this.layout) {
            const layoutPath = resolveAppFile(this.appDir, "_layout");
            if (layoutPath) {
                const layoutMod = await import(pathToFileURL(layoutPath).href);
                this.layout = layoutMod.default;
            }
        }

        // Resolve page file — fall back to _404 when path has no matching file
        let pagePath = resolveAppFile(this.appDir, pageSegment);
        let httpStatus = 200;
        if (!pagePath) {
            pagePath = resolveAppFile(this.appDir, "_404");
            httpStatus = 404;
        }

        if (!pagePath) {
            return this.sendHtml(res, 404, "<html><head></head><body><h1>404 Not Found</h1></body></html>");
        }

        let html: string;
        try {
            const mod = await import(pathToFileURL(pagePath).href);
            const PageComponent = mod.default;
            const pageFetchProps: ((req: HttpRequest) => Promise<any>) | undefined = mod.fetchProps;

            // Check to see if there's a react service for this page path
            const service: any = this.services.get(pageSegment);

            // There are three levels of fetching props: Page => Service => Route
            const pageProps = pageFetchProps ? await pageFetchProps(req) : {};
            const serviceProps = service ? await service.fetchProps(req) : {};
            const routeProps = (await this.fetchProps(req)) ?? {};
            const props = { user: req.user, userUid: req.user?.uid, ...pageProps, ...serviceProps, ...routeProps };

            const Layout = this.layout;
            const content = this.hydrate
                ? <div id={this.hydrateRootId}><PageComponent {...props} /></div>
                : <PageComponent {...props} />;

            html = renderToString(Layout ? <Layout>{content}</Layout> : content);

            if (this.hydrate) {
                html = this.injectHydrationAssets(html, props, pagePath);
            }
        } catch (err) {
            this.logger.error(`[ReactRoute] SSR error for "${req.path}":`, err);
            httpStatus = 500;

            const errorPath = resolveAppFile(this.appDir, "_500");
            if (errorPath) {
                try {
                    const errMod = await import(pathToFileURL(errorPath).href);
                    const ErrorPage = errMod.default;
                    const Layout = this.layout;
                    html = renderToString(
                        Layout
                            ? <Layout><ErrorPage error={err} /></Layout>
                            : <ErrorPage error={err} />
                    );
                } catch {
                    html = "<html><head></head><body><h1>500 Internal Server Error</h1></body></html>";
                }
            } else {
                html = "<html><head></head><body><h1>500 Internal Server Error</h1></body></html>";
            }
        }

        // Inject dev live-reload script
        if (process.env.NODE_ENV !== "production") {
            html = this.injectDevReloadScript(html);
        }

        // For non-200 responses, send the response ourselves so the status code is preserved.
        // The RapidREST middleware wrapper always applies status 200 to return values, so we
        // bypass it by calling res.send() directly and returning res.
        if (httpStatus !== 200) {
            return this.sendHtml(res, httpStatus, html);
        }

        // Production-only cache (don't cache non-200)
        if (process.env.NODE_ENV === "production" && this.cacheClient) {
            void this.cacheClient.setex(this.hashRequest(req), this.cacheTTL, html);
        }

        return html;
    }

    /** Sends an HTML response with the given status code, bypassing the middleware wrapper. */
    private sendHtml(res: HttpResponse, status: number, html: string): HttpResponse {
        (res as any).status?.(status);
        (res as any).setHeader?.("content-type", "text/html");
        (res as any).send?.(html);
        return res;
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
        const r = res as any;
        r.writeHeader("Content-Type", "text/event-stream");
        r.writeHeader("Cache-Control", "no-cache");
        r.writeHeader("Access-Control-Allow-Origin", "*");
        r.write(": connected\n\n");

        const onReload = () => r.write("data: reload\n\n");
        _devReloadEmitter.on("reload", onReload);
        r.onAborted?.(() => _devReloadEmitter.off("reload", onReload));
        // Do NOT call res.end() — the SSE stream stays open.
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

    private resolveManifest(): Record<string, { file: string; css?: string[] }> | null {
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
            const entryKey = path.relative(process.cwd(), pagePath).replace(/\\/g, "/");
            const entry = manifest[entryKey];
            if (entry) {
                return { js: `/${entry.file}`, css: (entry.css ?? []).map((f) => `/${f}`) };
            }
            this.logger.warn(
                `[ReactRoute] Manifest entry "${entryKey}" not found. ` +
                `Available keys: ${Object.keys(manifest).join(", ")}`
            );
        }
        throw new Error(
            `[ReactRoute] hydrate=true requires react.manifestPath to be configured ` +
            `and a matching Vite manifest entry for "${pagePath}".`
        );
    }

    private injectHydrationAssets(html: string, props: any, pagePath: string): string {
        const { js, css } = this.resolveClientUrls(pagePath);
        const safeProps = JSON.stringify(props ?? null).replace(/<\/script>/gi, "<\\/script>");
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
