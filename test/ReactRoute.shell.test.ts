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

const APP = "test/fixtures/shell-app";

/** A router-mode route over the shell fixture app: `_layout.tsx`, `_shell.tsx`, and pages, some with a `title`. */
class ShellRoute extends ReactRoute {
    protected readonly appDir: string = APP;
    protected readonly router: boolean = true;

    constructor() {
        super();
        (this as any).logger = logger;
    }

    public setManifestPath(p: string) {
        (this as any).manifestPath = p;
    }
}

/** The same app on a route that didn't opt in to the router (it hydrates, but has nothing to keep mounted between pages). */
class HydrateRoute extends ShellRoute {
    protected readonly router: boolean = false;
    protected readonly hydrate: boolean = true;
}

/** ...and one that doesn't hydrate at all. */
class StaticRoute extends ShellRoute {
    protected readonly router: boolean = false;
}

/** What Vite writes for a router build: the router entry (which has the shell in it), and a hydration entry per page. */
function pageRecords(page: string) {
    const source = `${APP}/${page}.tsx`;
    const slug = page.replace(/\W+/g, "-");
    return {
        [source]: { file: `assets/${slug}-page.js`, isDynamicEntry: true },
        [`rapidrest-entry:${source}`]: {
            file: `assets/${slug}-entry.js`,
            name: source,
            isEntry: true,
            imports: [source],
        },
    };
}

const MANIFEST = {
    [`rapidrest-router:${APP}`]: {
        file: "assets/router-abc.js",
        name: `${APP}/__router`,
        isEntry: true,
        css: ["assets/shell.css"],
    },
    ...pageRecords("index"),
    ...pageRecords("pets"),
    ...pageRecords("plain"),
    ...pageRecords("boom"),
    ...pageRecords("untitled"),
    ...pageRecords("slow-title"),
    ...pageRecords("bad-title"),
};

describe("ReactRoute with a persistent shell", () => {
    let dir: string;
    let manifestPath: string;
    const env = { ...process.env };

    function route<T extends ShellRoute>(cls: new () => T = ShellRoute as any): T {
        const r = new cls();
        r.setManifestPath(manifestPath);
        return r;
    }

    const navigation = (over: Partial<HttpRequest> = {}) =>
        fakeRequest({ headers: { [NAVIGATION_HEADER.toLowerCase()]: "1" }, ...over });

    const page = (r: ShellRoute, pagePath: string, over: Partial<HttpRequest> = {}): Promise<string> =>
        r.get(fakeRequest({ path: pagePath, url: pagePath, ...over }), fakeResponse()) as any;

    const payloadOf = async (r: ShellRoute, pagePath: string) => {
        const res = fakeResponse();
        await r.get(navigation({ path: pagePath, url: pagePath }), res);
        return JSON.parse(res.send.mock.calls[0][0]);
    };

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "rrst-shell-"));
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

    describe("the server's render", () => {
        it("puts the shell inside the hydration root, around the page, which is the page's props' shell too", async () => {
            const html = await page(route(), "/pets");

            expect(html).toContain('<div id="react-root"><div id="shell" data-path="/pets" data-route="/pets">');
            expect(html).toContain("<main><ul><li>rex</li></ul></main></div></div>");
            // The layout is outside the root, as ever.
            expect(html).toMatch(/<body><div id="react-root">/);
        });

        it("gives the shell the page's props, so what the page's fetchProps returns reaches it too", async () => {
            const html = await page(route(), "/");
            expect(html).toContain('data-user="jp"');
            expect(html).toContain("<main><h1>home</h1></main>");
        });

        it("renders inside the router, so the shell reads the location the browser will hydrate with", async () => {
            const html = await page(route(), "/pets", { url: "/pets?tab=1" });
            // (`NavLink`, in the shell, knows which link is where the page is.)
            expect(html).toContain('<a aria-current="page" href="/pets">Pets</a>');
            expect(html).toContain('<a href="/">Home</a>');
        });

        it("tells the client the shell is there, so that it hydrates the tree the markup is of", async () => {
            const html = await page(route(), "/pets");
            expect(html).toContain('"route":"/pets","rootId":"react-root","propsId":"react-props","css":["/assets/shell.css"],"shell":true}');
        });

        it("is answered for a navigation with the page's payload alone — the shell is already on screen", async () => {
            const payload = await payloadOf(route(), "/pets");
            expect(payload.route).toBe("/pets");
            expect(payload).not.toHaveProperty("shell");
        });

        it("is used only by a route with the router: nothing to keep mounted without one", async () => {
            for (const cls of [HydrateRoute, StaticRoute]) {
                const html = await page(route(cls), "/plain");
                expect(html).toContain("<p>plain</p>");
                expect(html).not.toContain('id="shell"');
            }
        });

        it("is not put around the 404 page, which isn't hydrated", async () => {
            const res = fakeResponse();
            await route().get(fakeRequest({ path: "/nope", url: "/nope" }), res);
            expect(res.status).toHaveBeenCalledWith(404);
            expect(res.send.mock.calls[0][0]).not.toContain('id="shell"');
        });

        it("loads the shell once and keeps it (a shell is a module: it isn't imported for every request)", async () => {
            const r = route();
            await page(r, "/pets");
            const shell = (r as any).shell;
            expect(typeof shell).toBe("function");
            await page(r, "/plain");
            expect((r as any).shell).toBe(shell);
        });

        it("is left out, and looked for again next time, by an app that doesn't have one", async () => {
            class NoShellRoute extends ShellRoute {
                protected async resolveAppFile(appDir: string, segment: string, internal?: boolean) {
                    return segment === "_shell" ? null : super.resolveAppFile(appDir, segment, internal);
                }
            }
            const r = route(NoShellRoute);
            const html = await page(r, "/plain");
            expect(html).toContain('<div id="react-root"><p>plain</p></div>');
            expect(html).not.toContain('"shell":true');
            expect((r as any).shell).toBeNull();
        });

        it("fails like any other page that throws while it renders: the server's 500", async () => {
            const r = route();
            (r as any).shell = () => {
                throw new Error("shell broke");
            };
            const res = fakeResponse();

            await r.get(fakeRequest({ path: "/pets", url: "/pets" }), res);

            expect(res.status).toHaveBeenCalledWith(500);
            expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('"/pets"'), expect.any(Error));
        });
    });

    describe("the page's own title", () => {
        it("is made from the page's props by a `title` function, and replaces the layout's", async () => {
            const html = await page(route(), "/");
            expect(html).toContain("<title>Home for jp</title>");
            expect(html).not.toContain("layout title");
        });

        it("can be a plain string, which is escaped as React would escape it", async () => {
            const html = await page(route(), "/pets");
            expect(html).toContain("<title>Pets &amp; &lt;more&gt;</title>");
        });

        it("can be worked out asynchronously", async () => {
            expect(await page(route(), "/slow-title")).toContain("<title>Slow title</title>");
        });

        it("leaves the layout's alone for a page without one, or with something that isn't a title", async () => {
            expect(await page(route(), "/plain")).toContain("<title>layout title</title>");
            expect(await page(route(), "/untitled")).toContain("<title>layout title</title>");
        });

        it("applies to any route, not only one with the router", async () => {
            for (const cls of [HydrateRoute, StaticRoute]) {
                expect(await page(route(cls), "/pets")).toContain("<title>Pets &amp; &lt;more&gt;</title>");
            }
        });

        it("keeps the attributes of the title it replaces", async () => {
            const r = route();
            (r as any).layout = ({ children }: any) =>
                createElement("html", null, createElement("head", null, createElement("title", { id: "t" }, "old")), createElement("body", null, children));
            const html = await page(r, "/pets");
            expect(html).toContain('<title id="t">Pets &amp; &lt;more&gt;</title>');
        });

        it("adds a title to a layout's head that has none", async () => {
            const r = route();
            (r as any).layout = ({ children }: any) =>
                createElement("html", null, createElement("head", null, createElement("meta", { charSet: "utf-8" })), createElement("body", null, children));
            const html = await page(r, "/pets");
            expect(html).toContain('<meta charSet="utf-8"/><title>Pets &amp; &lt;more&gt;</title>');
        });

        it("has nowhere to go in a document with no head, and doesn't touch an SVG's title in the body", async () => {
            const r = route();
            (r as any).layout = ({ children }: any) =>
                createElement("div", null, createElement("svg", null, createElement("title", null, "icon")), children);
            const html = await page(r, "/pets");
            expect(html).toContain("<title>icon</title>");
            expect(html).not.toContain("Pets &amp;");
        });

        it("is the title a client navigation sets, ahead of the layout's", async () => {
            expect((await payloadOf(route(), "/")).title).toBe("Home for jp");
            expect((await payloadOf(route(), "/pets")).title).toBe("Pets & <more>");
        });

        it("falls back, for a navigation, to the layout's title", async () => {
            expect((await payloadOf(route(), "/plain")).title).toBe("layout title");
            expect((await payloadOf(route(), "/untitled")).title).toBe("layout title");
        });

        it("is a failure of the navigation, not silently the layout's, when the page's title function throws", async () => {
            const res = fakeResponse();
            await route().get(navigation({ path: "/bad-title", url: "/bad-title" }), res);
            expect(res.status).toHaveBeenCalledWith(500);
            expect(JSON.parse(res.send.mock.calls[0][0])).toEqual({ status: 500 });
        });

        it("is a 500 of the render, as any error of the page's, when the title function throws", async () => {
            const res = fakeResponse();
            await route().get(fakeRequest({ path: "/bad-title", url: "/bad-title" }), res);
            expect(res.status).toHaveBeenCalledWith(500);
        });
    });
});
