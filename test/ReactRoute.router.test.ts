///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import fs from "fs";
import os from "os";
import path from "path";
import { createElement } from "react";
import { vi } from "vitest";
import { HttpRequest, HttpResponse } from "@rapidrest/service-core";
import { ReactRoute } from "../src/ReactRoute.js";
import { NAVIGATION_HEADER } from "../src/routerCore.js";

function fakeRequest(overrides: Partial<HttpRequest>): HttpRequest {
    return {
        method: "GET",
        path: "/",
        url: "/",
        headers: {},
        params: {},
        query: {},
        body: undefined,
        cookies: {},
        signedCookies: {},
        socket: {},
        ...overrides,
    };
}

function fakeResponse(): HttpResponse & Record<string, any> {
    return {
        statusCode: 200,
        headersSent: false,
        writableEnded: false,
        status: vi.fn(),
        setHeader: vi.fn(),
        getHeader: vi.fn(),
        json: vi.fn(),
        send: vi.fn(),
        end: vi.fn(),
        flushHeaders: vi.fn(),
        write: vi.fn(),
        onAbort: vi.fn(),
    } as any;
}

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** A router-mode route over the router fixture app. */
class RouterRoute extends ReactRoute {
    protected readonly appDir = "test/fixtures/router-app";
    protected readonly router = true;

    constructor() {
        super();
        (this as any).logger = logger;
    }

    public setManifestPath(p: string) {
        (this as any).manifestPath = p;
    }

    public setManifest(manifest: any) {
        (this as any).manifest = manifest;
    }

    public setCacheClient(client: any) {
        (this as any).cache = client;
    }

    public resolve(segment: string) {
        return this.resolveAppFile(this.appDir, segment);
    }
}

/** The same fixture app on a route that didn't opt in. */
class PlainRoute extends RouterRoute {
    protected readonly router = false;
}

/**
 * What Vite writes for a router build of the fixture app: the router entry, and a hydration entry per page — named for the
 * page's source (with `[id]` sanitized), and importing the page's own chunk, which the router loads dynamically.
 */
function pageRecords(dir: string, page: string, chunk: any, entry: any = {}) {
    const source = `${dir}/${page}.tsx`;
    const name = source.replace(/[[\]]/g, "_");
    const slug = page.replace(/\W+/g, "-");
    return {
        [source]: { file: `assets/${slug}-page.js`, isDynamicEntry: true, ...chunk },
        [`rapidrest-entry:${name}`]: {
            file: `assets/${slug}-entry.js`,
            name: source.replace(/[[\]]/g, "_"),
            isEntry: true,
            ...entry,
            imports: [source, ...(entry.imports ?? [])],
        },
    };
}

const APP = "test/fixtures/router-app";
const MANIFEST = {
    "rapidrest-router:test/fixtures/router-app": {
        file: "assets/router-abc.js",
        name: `${APP}/__router`,
        isEntry: true,
        css: ["assets/router.css"],
        imports: ["_shared.js"],
    },
    "_shared.js": { file: "assets/shared-1.js", css: ["assets/shared.css"] },
    ...pageRecords(APP, "index", { css: ["assets/index.css"], imports: ["_shared.js"] }),
    ...pageRecords(APP, "pets", {}),
    ...pageRecords(APP, "pets/[id]", { file: "assets/pet-4.js", css: ["assets/pet.css"] }),
    ...pageRecords(APP, "boom", {}),
};

describe("ReactRoute router mode", () => {
    let dir: string;
    let manifestPath: string;
    const env = { ...process.env };

    function route(cls: new () => RouterRoute = RouterRoute) {
        const r = new cls();
        r.setManifestPath(manifestPath);
        return r;
    }

    const navigation = (over: Partial<HttpRequest> = {}) =>
        fakeRequest({ headers: { [NAVIGATION_HEADER.toLowerCase()]: "1" }, ...over });

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "rrst-router-"));
        manifestPath = path.join(dir, ".vite", "manifest.json");
        fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
        fs.writeFileSync(manifestPath, JSON.stringify(MANIFEST));
    });

    afterAll(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    afterEach(() => {
        process.env.NODE_ENV = env.NODE_ENV;
        vi.clearAllMocks();
    });

    describe("route templates", () => {
        it("reports the template of the route each URL resolved to", async () => {
            const r = route();
            expect((await r.resolve("/"))?.template).toBe("/");
            expect((await r.resolve("/pets"))?.template).toBe("/pets");
            expect((await r.resolve("/pets/new"))?.template).toBe("/pets/new");
            expect((await r.resolve("/pets/7"))?.template).toBe("/pets/:id");
            expect((await r.resolve("/nested"))?.template).toBe("/nested");
            expect((await r.resolve("/nested"))?.params).toEqual({});
            expect((await r.resolve("/pets/7"))?.params).toEqual({ id: "7" });
        });

        it("has none for a URL no page serves", async () => {
            expect(await route().resolve("/nope")).toBeNull();
        });
    });

    describe("the page's HTML", () => {
        it("is hydrated by the router entry, with the config the client needs and the assets the page needs", async () => {
            const res = fakeResponse();

            const html: string = await route().get(fakeRequest({ path: "/pets/7", url: "/pets/7?tab=1" }), res);

            expect(html).toContain('<div id="react-root"><p data-param="7">pet 7</p></div>');
            expect(html).toContain(
                '<script type="application/json" id="rapidrest-router">' +
                    '{"prefix":"","route":"/pets/:id","rootId":"react-root","propsId":"react-props",' +
                    '"css":["/assets/router.css","/assets/shared.css","/assets/pet.css"]}</script>',
            );
            expect(html).toContain('<script type="application/json" id="react-props">');
            expect(html).toContain('"petId":"7"');
            // One router entry serves every page: no per-page entry.
            expect(html).toContain('<script type="module" src="/assets/router-abc.js"></script>');
            expect(html).not.toContain("/assets/pet-4.js\"></script>");
            // Both the router's and the page's stylesheets (and what they import), and the page's module, ahead of time.
            for (const css of ["/assets/router.css", "/assets/shared.css", "/assets/pet.css"]) {
                expect(html).toContain(`<link rel="stylesheet" href="${css}">`);
            }
            expect(html).toContain('<link rel="modulepreload" href="/assets/pet-4.js">');
        });

        it("renders the page inside the router, so the location matches what the browser will hydrate", async () => {
            const html: string = await route().get(fakeRequest({ path: "/", url: "/?a=1&b=2" }), fakeResponse());

            expect(html).toContain('data-path="/" data-search="?a=1&amp;b=2" data-route="/"');
            expect(html).toContain('<a href="/pets">Pets</a>');
        });

        it("has an empty search when the URL has no query", async () => {
            const html: string = await route().get(fakeRequest({ path: "/", url: "/" }), fakeResponse());
            expect(html).toContain('data-search=""');
        });

        it("rebuilds the search from the parsed query when the adapter leaves it out of the url", async () => {
            const req = fakeRequest({ path: "/", url: "/", query: { a: "1", b: ["x", "y z"] } });
            const html: string = await route().get(req, fakeResponse());
            expect(html).toContain('data-search="?a=1&amp;b=x&amp;b=y+z"');
        });

        it("treats a request with no url at all as having no query", async () => {
            const html: string = await route().get(fakeRequest({ path: "/", url: undefined }), fakeResponse());
            expect(html).toContain('data-search=""');
            const noQuery: string = await route().get(fakeRequest({ path: "/", url: undefined, query: undefined }), fakeResponse());
            expect(noQuery).toContain('data-search=""');
        });

        it("hydrates without hydrate being set: the router implies it", async () => {
            const html: string = await route().get(fakeRequest({ path: "/pets" }), fakeResponse());
            expect(html).toContain('id="react-root"');
            expect(html).toContain('id="react-props"');
        });

        it("tells caches it varies on the navigation header", async () => {
            const res = fakeResponse();
            await route().get(fakeRequest({ path: "/pets" }), res);
            expect(res.setHeader).toHaveBeenCalledWith("Vary", NAVIGATION_HEADER);
        });

        it("falls back to the server's error page when the router's assets can't be found", async () => {
            const r = route();
            r.setManifestPath(path.join(dir, "no-such-manifest.json"));
            const res = fakeResponse();

            await r.get(fakeRequest({ path: "/pets" }), res);

            expect(res.status).toHaveBeenCalledWith(500);
            expect(logger.error).toHaveBeenCalled();
            expect(logger.error.mock.calls[0][1].message).toContain("router=true requires react.manifestPath");
        });

        it("says which manifest entries are missing when the build wasn't made with the router", async () => {
            const r = route();
            const stale = path.join(dir, "stale.json");
            fs.writeFileSync(stale, JSON.stringify({ "test/fixtures/router-app/pets.tsx": { file: "assets/pets.js" } }));
            r.setManifestPath(stale);
            const res = fakeResponse();

            await r.get(fakeRequest({ path: "/pets" }), res);

            expect(res.status).toHaveBeenCalledWith(500);
            expect(logger.error.mock.calls[0][1].message).toContain("createViteConfig({ router: true })");
        });
    });

    describe("a navigation request", () => {
        it("is answered with the page's props as JSON, the route it is, and the stylesheets it needs", async () => {
            const res = fakeResponse();

            const returned = await route().get(navigation({ path: "/pets/7", url: "/pets/7" }), res);

            expect(returned).toBe(res);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.setHeader).toHaveBeenCalledWith("content-type", "application/json");
            expect(res.setHeader).toHaveBeenCalledWith("Vary", NAVIGATION_HEADER);
            expect(res.setHeader).toHaveBeenCalledWith("X-Content-Type-Options", "nosniff");
            const payload = JSON.parse(res.send.mock.calls[0][0]);
            expect(payload).toEqual({
                route: "/pets/:id",
                props: { params: { id: "7" }, petId: "7" },
                css: ["/assets/router.css", "/assets/shared.css", "/assets/pet.css"],
                // What the layout renders as the title: nothing else re-renders the layout in the browser.
                title: "router fixture",
            });
        });

        describe("the title", () => {
            const send = async (r: RouterRoute, url = "/pets/7") => {
                const res = fakeResponse();
                await r.get(navigation({ path: url, url }), res);
                return JSON.parse(res.send.mock.calls[0][0]);
            };
            const layoutOf = (title: (props: any) => string | undefined) => ({ children, petId }: any) =>
                createElement("html", null, createElement("head", null, title(petId) === undefined ? null : createElement("title", null, title(petId))), createElement("body", null, children));

            it("follows the page: it is the layout's title for that page's props", async () => {
                const r = route();
                (r as any).layout = layoutOf((petId) => `Pet ${petId}`);
                expect((await send(r)).title).toBe("Pet 7");
            });

            it("is the text as a browser reads it: entities decoded", async () => {
                const r = route();
                (r as any).layout = layoutOf((petId) => `Pet ${petId} & "co" <b> it's`);
                expect((await send(r)).title).toBe(`Pet 7 & "co" <b> it's`);
            });

            it("reads a title with attributes, and the first of several", async () => {
                const r = route();
                (r as any).layout = ({ children }: any) =>
                    createElement("html", null, createElement("head", null, createElement("title", { id: "t" }, "First"), createElement("title", null, "Second")), createElement("body", null, children));
                expect((await send(r)).title).toBe("First");
            });

            it("is left out when the layout has no title", async () => {
                const r = route();
                (r as any).layout = layoutOf(() => undefined);
                expect("title" in (await send(r))).toBe(false);
            });

            it("is left out when there is no layout", async () => {
                class NoLayoutRoute extends RouterRoute {
                    protected async resolveAppFile(appDir: string, segment: string, internal?: boolean) {
                        return segment === "_layout" ? null : super.resolveAppFile(appDir, segment, internal);
                    }
                }
                const payload = await send(route(NoLayoutRoute));
                expect(payload.route).toBe("/pets/:id");
                expect("title" in payload).toBe(false);
            });

            it("costs the navigation its title, not the navigation, when the layout fails to render", async () => {
                const r = route();
                (r as any).layout = () => {
                    throw new Error("layout broke");
                };
                const payload = await send(r);
                expect(payload.route).toBe("/pets/:id");
                expect("title" in payload).toBe(false);
                expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("title"), expect.any(Error));
            });
        });

        it("carries the very props the server would have rendered the page with", async () => {
            const r = route();
            const html: string = await r.get(fakeRequest({ path: "/", url: "/" }), fakeResponse());
            const res = fakeResponse();
            await r.get(navigation({ path: "/", url: "/" }), res);

            const embedded = JSON.parse(/id="react-props">(.*?)<\/script>/.exec(html)![1]);
            expect(JSON.parse(res.send.mock.calls[0][0]).props).toEqual(embedded);
        });

        it("is answered with only a status, for the browser to load the page itself, when there's no such page", async () => {
            const res = fakeResponse();

            await route().get(navigation({ path: "/nope", url: "/nope" }), res);

            expect(res.status).toHaveBeenCalledWith(404);
            expect(JSON.parse(res.send.mock.calls[0][0])).toEqual({ status: 404 });
        });

        it("is answered with only a status when computing the props fails, and the failure is logged", async () => {
            const res = fakeResponse();

            await route().get(navigation({ path: "/boom", url: "/boom" }), res);

            expect(res.status).toHaveBeenCalledWith(500);
            expect(JSON.parse(res.send.mock.calls[0][0])).toEqual({ status: 500 });
            expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('"/boom"'), expect.any(Error));
        });

        it("is answered with only a status when the page's assets can't be found", async () => {
            const r = route();
            r.setManifestPath(path.join(dir, "no-such-manifest.json"));
            const res = fakeResponse();

            await r.get(navigation({ path: "/pets", url: "/pets" }), res);

            expect(res.status).toHaveBeenCalledWith(500);
        });

        it("is answered with the ordinary HTML by a route that didn't opt in, without Vary", async () => {
            const res = fakeResponse();

            const html: string = await route(PlainRoute).get(navigation({ path: "/pets", url: "/pets" }), res);

            expect(html).toContain("<li>rex</li>");
            expect(res.setHeader).not.toHaveBeenCalledWith("Vary", expect.anything());
        });

        it("ignores a navigation header with any other value", async () => {
            const html: string = await route().get(
                fakeRequest({ path: "/pets", headers: { [NAVIGATION_HEADER.toLowerCase()]: "0" } }),
                fakeResponse(),
            );
            expect(html).toContain("<li>rex</li>");
        });

        it("copes with a request that has no headers at all", async () => {
            const html: string = await route().get(fakeRequest({ path: "/pets", headers: undefined }), fakeResponse());
            expect(html).toContain("<li>rex</li>");
        });
    });

    describe("caching (production)", () => {
        function cached() {
            process.env.NODE_ENV = "production";
            const r = route();
            r.setManifest(MANIFEST);
            const client = { load: vi.fn(), save: vi.fn().mockResolvedValue(undefined) };
            r.setCacheClient(client);
            return { r, client };
        }

        it("caches the JSON of a page it computed, apart from the HTML", async () => {
            const { r, client } = cached();

            await r.get(navigation({ path: "/pets", url: "/pets" }), fakeResponse());

            expect(client.load).toHaveBeenCalledTimes(1);
            const key = client.load.mock.calls[0][0];
            expect(key.endsWith(".navigation")).toBe(true);
            expect(client.save).toHaveBeenCalledWith(key, { json: expect.stringContaining('"route":"/pets"') }, 60);
        });

        it("serves a cached page without computing anything", async () => {
            const { r, client } = cached();
            client.load.mockResolvedValue({ json: '{"route":"/pets","props":{},"css":[]}' });
            const res = fakeResponse();

            await r.get(navigation({ path: "/pets", url: "/pets" }), res);

            expect(res.send).toHaveBeenCalledWith('{"route":"/pets","props":{},"css":[]}');
            expect(client.save).not.toHaveBeenCalled();
        });

        it("doesn't cache what isn't a page", async () => {
            const { r, client } = cached();
            await r.get(navigation({ path: "/nope", url: "/nope" }), fakeResponse());
            expect(client.save).not.toHaveBeenCalled();
        });

        it("carries on when the cache can't be read, or written", async () => {
            const { r, client } = cached();
            client.load.mockRejectedValueOnce(new Error("redis down"));
            client.save.mockRejectedValueOnce(new Error("redis down"));
            const res = fakeResponse();

            await r.get(navigation({ path: "/pets", url: "/pets" }), res);
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(res.status).toHaveBeenCalledWith(200);
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Cache read failed"), expect.any(Error));
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to write cache"), expect.any(Error));
        });

        it("reads a cache entry with no JSON in it as a miss", async () => {
            const { r, client } = cached();
            client.load.mockResolvedValue({ html: "<p>not json</p>" });
            const res = fakeResponse();

            await r.get(navigation({ path: "/pets", url: "/pets" }), res);

            expect(JSON.parse(res.send.mock.calls[0][0]).route).toBe("/pets");
        });

        it("works with no cache backend configured", async () => {
            process.env.NODE_ENV = "production";
            const r = route();
            r.setManifest(MANIFEST);
            const res = fakeResponse();

            await r.get(navigation({ path: "/pets", url: "/pets" }), res);

            expect(res.status).toHaveBeenCalledWith(200);
        });
    });
});

describe("ReactRoute router assets", () => {
    let dir: string;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "rrst-router-assets-"));
    });

    afterAll(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function write(name: string, manifest: any): string {
        const p = path.join(dir, name, ".vite", "manifest.json");
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(manifest));
        return p;
    }

    const assets = (route: any, page: string) => route.resolveRouterAssets(path.resolve(page));

    it("finds a compiled app's entry and pages under the source directory they were built from", () => {
        class CompiledRoute extends RouterRoute {
            protected readonly appDir = "dist/apps/www";
        }
        const route = new CompiledRoute();
        route.setManifestPath(
            write("compiled", {
                "rapidrest-router:apps/www": { file: "assets/router.js", name: "apps/www/__router", css: ["assets/router.css"] },
                ...pageRecords("apps/www", "index", { file: "assets/index.js", css: ["assets/index.css"] }),
            }),
        );

        expect(assets(route, "dist/apps/www/index.js")).toEqual({
            entry: "/assets/router.js",
            css: ["/assets/router.css", "/assets/index.css"],
            preload: ["/assets/index.js"],
        });
    });

    it("finds a page's entry by its name even when a chunk of the page itself has swallowed its source key", () => {
        const route = new RouterRoute();
        route.setManifestPath(
            write("swallowed", {
                "rapidrest-router:test/fixtures/router-app": { file: "assets/router.js", name: `${APP}/__router` },
                // The page's module lives inside some shared chunk under another name; its source key doesn't exist.
                "_chunk.js": { file: "assets/chunk.js", css: ["assets/chunk.css"] },
                "rapidrest-entry:test/fixtures/router-app/pets.tsx": {
                    file: "assets/entry.js",
                    name: `${APP}/pets.tsx`,
                    imports: ["_chunk.js"],
                },
            }),
        );

        expect(assets(route, `${APP}/pets.tsx`)).toEqual({
            entry: "/assets/router.js",
            css: ["/assets/chunk.css"],
            preload: ["/assets/chunk.js"],
        });
    });

    it("lists a stylesheet or module shared by several chunks once, and skips an import the manifest doesn't have", () => {
        const route = new RouterRoute();
        route.setManifestPath(
            write("shared", {
                "rapidrest-router:test/fixtures/router-app": {
                    file: "assets/router.js",
                    name: "test/fixtures/router-app/__router",
                    imports: ["_a.js", "_b.js", "_gone.js"],
                },
                "_a.js": { file: "assets/a.js", css: ["assets/shared.css"], imports: ["_shared.js"] },
                "_b.js": { file: "assets/b.js", imports: ["_shared.js"] },
                "_shared.js": { file: "assets/shared.js", css: ["assets/shared.css"] },
                ...pageRecords(APP, "index", { file: "assets/index.js", imports: ["_shared.js", "_gone.js"] }),
            }),
        );

        const result = assets(route, "test/fixtures/router-app/index.tsx");

        expect(result.css).toEqual(["/assets/shared.css"]);
        // The router entry loads shared.js itself, so it needs no hint; the page's own chunk does.
        expect(result.preload).toEqual(["/assets/index.js"]);
    });

    describe("injecting them into a page", () => {
        function inject(html: string) {
            const route = new RouterRoute();
            route.setManifestPath(
                write("inject", {
                    "rapidrest-router:test/fixtures/router-app": {
                        file: "assets/router.js",
                        name: "test/fixtures/router-app/__router",
                    },
                    ...pageRecords(APP, "index", { file: "assets/index.js", css: ["assets/index.css"] }),
                }),
            );
            return (route as any).injectRouterAssets(html, { a: 1 }, path.resolve("test/fixtures/router-app/index.tsx"), "/");
        }

        it("puts the stylesheets in the head, and the config, props and entry at the end of the body", () => {
            const html = inject("<html><head></head><body><p>x</p></body></html>");
            expect(html.indexOf('<link rel="stylesheet" href="/assets/index.css">')).toBeLessThan(html.indexOf("</head>"));
            expect(html.indexOf('id="rapidrest-router"')).toBeGreaterThan(html.indexOf("<p>x</p>"));
            expect(html.indexOf('src="/assets/router.js"')).toBeLessThan(html.indexOf("</body>"));
            expect(html).toContain('id="react-props">{"a":1}</script>');
        });

        it("still works for a document with no head, or no body, or neither", () => {
            const noHead = inject("<html><body>x</body></html>");
            expect(noHead).not.toContain('rel="stylesheet"');
            expect(noHead.indexOf('src="/assets/router.js"')).toBeLessThan(noHead.indexOf("</body>"));

            const noBody = inject("<html><p>x</p></html>");
            expect(noBody.indexOf('src="/assets/router.js"')).toBeLessThan(noBody.indexOf("</html>"));

            const bare = inject("<p>x</p>");
            expect(bare.startsWith("<p>x</p><script")).toBe(true);
            expect(bare.endsWith('src="/assets/router.js"></script>')).toBe(true);
        });
    });
});
