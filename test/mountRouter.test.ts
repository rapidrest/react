///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { vi } from "vitest";
import { mountRouter, RECOVERY_KEY } from "../src/router.js";
import { usePathname, useParams } from "../src/routerContext.js";
import { ROUTER_CONFIG_ID } from "../src/routerCore.js";

vi.mock("react-dom/client", () => ({ createRoot: vi.fn() }));
vi.mock("react-dom", () => ({ flushSync: (fn: () => void) => fn() }));

/*
 * mountRouter() against a fake window/document, the same way router.test.ts and router.features.test.ts exercise
 * startRouter(): what's shared with startRouter() (createBrowserPlatform(), the Router class, matchClientRoute()) is
 * already covered by those suites and isn't re-derived here — only what's specific to mounting client-side-only (the
 * guard clauses, resolving the initial route and props without any server config, and createRoot() instead of
 * hydrateRoot()) is.
 */

const HREF = "https://example.com/admin/users/7?tab=1";

function makeWindow(href = HREF, over: Record<string, any> = {}) {
    const listeners: Record<string, Array<(event: any) => void>> = {};
    const timers: Array<() => void> = [];
    const win: any = {
        location: { href, assign: vi.fn(), reload: vi.fn() },
        history: { state: null as any, length: 3, scrollRestoration: "auto", pushState: vi.fn(), replaceState: vi.fn(), go: vi.fn() },
        confirm: vi.fn(() => true),
        clearTimeout: vi.fn(),
        removeEventListener: vi.fn(),
        scrollX: 10,
        scrollY: 20,
        scrollTo: vi.fn(),
        fetch: vi.fn(),
        setTimeout: vi.fn((handler: () => void) => timers.push(handler)),
        addEventListener: vi.fn((type: string, handler: (event: any) => void) => {
            (listeners[type] ??= []).push(handler);
        }),
        sessionStorage: { getItem: vi.fn(() => null), setItem: vi.fn() },
        ...over,
    };
    return { win, listeners, timers };
}

function makeDocument(elements: Record<string, any> = {}) {
    const listeners: Record<string, Array<(event: any) => void>> = {};
    const links: any[] = [];
    const doc: any = {
        head: { appendChild: vi.fn((node: any) => links.push(node)) },
        body: { appendChild: vi.fn() },
        createElement: vi.fn(() => ({ setAttribute: vi.fn(), style: {} })),
        getElementById: vi.fn((id: string) => elements[id] ?? null),
        querySelector: vi.fn(() => null),
        querySelectorAll: vi.fn(() => links.filter((l) => l.rel === "stylesheet")),
        title: "Page title",
        readyState: "complete",
        addEventListener: vi.fn((type: string, handler: (event: any) => void) => {
            (listeners[type] ??= []).push(handler);
        }),
    };
    return { doc, listeners, links };
}

function makeContainer() {
    return { focus: vi.fn(), setAttribute: vi.fn(), removeAttribute: vi.fn(), style: { outline: "" } };
}

function Page(props: any) {
    return createElement("p", null, `id=${props?.id} path=${usePathname()} param=${useParams().id}`);
}

function Shell(props: any) {
    return createElement("div", { id: "shell" }, `label=${props?.label}`, props.children);
}

function setup(over: { elements?: Record<string, any>; href?: string; container?: any } = {}) {
    const container = over.container === undefined ? makeContainer() : over.container;
    const elements: Record<string, any> = { "react-root": container, ...over.elements };
    if (!container) delete elements["react-root"];
    const { win, listeners: winListeners, timers } = makeWindow(over.href);
    const { doc, listeners: docListeners, links } = makeDocument(elements);
    const loadUsers = vi.fn(async () => ({ default: Page }));
    const loadUser = vi.fn(async () => ({ default: Page }));
    const routes = [
        { template: "/users", load: loadUsers },
        { template: "/users/:id", load: loadUser },
    ];
    const render = vi.fn();
    vi.mocked(createRoot).mockReturnValue({ render } as any);
    return { win, doc, winListeners, docListeners, links, routes, loadUsers, loadUser, render, container, timers };
}

const click = (target: any, over: Record<string, any> = {}) => ({
    target,
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...over,
});
const anchor = (attrs: Record<string, string>) => ({
    getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
    hasAttribute: (name: string) => name in attrs,
});
const within = (a: any) => ({ closest: vi.fn(() => a) });

afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(createRoot).mockReset();
});

describe("mountRouter", () => {
    it("does nothing without a browser to mount in", async () => {
        expect(await mountRouter([], { rootId: "react-root" })).toBeUndefined();
    });

    it("uses the window and document it finds, when given none", async () => {
        const { win } = makeWindow("https://example.com/");
        const container = makeContainer();
        const { doc } = makeDocument({ "react-root": container });
        const render = vi.fn();
        vi.mocked(createRoot).mockReturnValue({ render } as any);
        (globalThis as any).window = win;
        (globalThis as any).document = doc;
        try {
            const router = await mountRouter([{ template: "/", load: async () => ({ default: () => null }) }], { rootId: "react-root" });
            expect(router).toBeDefined();
            expect(createRoot).toHaveBeenCalledWith(container);
        } finally {
            delete (globalThis as any).window;
            delete (globalThis as any).document;
        }
    });

    it("says so, and returns nothing, when there's no root element", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const s = setup({ container: null });

        expect(await mountRouter(s.routes, { rootId: "react-root" }, s.win, s.doc)).toBeUndefined();

        expect(error.mock.calls[0][0]).toContain("nothing to mount on");
        expect(createRoot).not.toHaveBeenCalled();
    });

    it("says so, and returns nothing, and never consults any #rapidrest-router config, when the URL matches no route", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const s = setup({ href: "https://example.com/admin/nope" });

        expect(await mountRouter(s.routes, { rootId: "react-root", prefix: "/admin" }, s.win, s.doc)).toBeUndefined();

        expect(error.mock.calls[0][0]).toContain('"/admin/nope"');
        expect(createRoot).not.toHaveBeenCalled();
        expect(s.doc.getElementById).not.toHaveBeenCalledWith(ROUTER_CONFIG_ID);
    });

    it("mounts the matched route into the given, plain root — no pre-existing children, no server config read at all", async () => {
        const s = setup();
        const resolveProps = vi.fn(async (route: any, params: any) => ({ id: params.id, from: route.template }));

        const router = await mountRouter(s.routes, { rootId: "react-root", prefix: "/admin", resolveProps }, s.win, s.doc);

        expect(router).toBeDefined();
        expect(s.loadUser).toHaveBeenCalledTimes(1);
        expect(createRoot).toHaveBeenCalledWith(s.container);
        expect(resolveProps).toHaveBeenCalledWith(s.routes[1], { id: "7" });
        expect(renderToString(s.render.mock.calls[0][0])).toBe("<p>id=7 path=/admin/users/7 param=7</p>");
        // Nothing about mounting ever looked for the hydration config or read a JSON script out of the document.
        expect(s.doc.getElementById).not.toHaveBeenCalledWith(ROUTER_CONFIG_ID);
        expect(s.doc.getElementById).toHaveBeenCalledWith("react-root");
    });

    it("renders with undefined props when there's no resolveProps", async () => {
        const s = setup();
        await mountRouter(s.routes, { rootId: "react-root", prefix: "/admin" }, s.win, s.doc);
        expect(renderToString(s.render.mock.calls[0][0])).toBe("<p>id=undefined path=/admin/users/7 param=7</p>");
    });

    it("matches at the mount root when no prefix is given", async () => {
        const s = setup({ href: "https://example.com/users/9" });
        const router = await mountRouter(s.routes, { rootId: "react-root" }, s.win, s.doc);
        expect(router).toBeDefined();
        expect(renderToString(s.render.mock.calls[0][0])).toBe("<p>id=undefined path=/users/9 param=9</p>");
    });

    describe("the shell", () => {
        it("renders it around the page from the very first render, since there's no server markup it has to agree with", async () => {
            const s = setup();
            const resolveProps = vi.fn(async () => ({ label: "L" }));

            await mountRouter(s.routes, { rootId: "react-root", prefix: "/admin", shell: Shell, resolveProps }, s.win, s.doc);

            expect(renderToString(s.render.mock.calls[0][0])).toBe(
                '<div id="shell">label=L<p>id=undefined path=/admin/users/7 param=7</p></div>',
            );
        });

        it("renders no shell when none is given", async () => {
            const s = setup();
            await mountRouter(s.routes, { rootId: "react-root", prefix: "/admin" }, s.win, s.doc);
            expect(renderToString(s.render.mock.calls[0][0])).not.toContain('id="shell"');
        });
    });

    describe("updating the page on screen", () => {
        it("keeps the page instance on a shallow update", async () => {
            const s = setup();
            const router = (await mountRouter(s.routes, { rootId: "react-root", prefix: "/admin" }, s.win, s.doc))!;

            await router.navigate("/admin/users/8?x=1", { shallow: true });

            const after = s.render.mock.calls[1][0];
            expect(after.props.location).toMatchObject({ pathname: "/admin/users/8", search: "?x=1", params: { id: "8" } });
            expect(s.win.fetch).not.toHaveBeenCalled();
        });

        it("gives the page the props it was fetched again with, as they are", async () => {
            const s = setup();
            const router = (await mountRouter(s.routes, { rootId: "react-root", prefix: "/admin" }, s.win, s.doc))!;
            s.win.fetch.mockResolvedValue({
                ok: true,
                redirected: false,
                headers: { get: () => "application/json" },
                json: async () => ({ route: "/users/:id", props: { id: "8" }, css: [] }),
            });

            await router.navigate("/admin/users/8", { shallow: true, refetch: true });

            const after = s.render.mock.calls.at(-1)![0];
            expect(after.props.children.props.children.props).toEqual({ id: "8" });
        });

        it("changes only the location for a #fragment, keeping props and params as they were", async () => {
            const s = setup();
            const resolveProps = vi.fn(async () => ({ id: "7" }));
            const router = (await mountRouter(s.routes, { rootId: "react-root", prefix: "/admin", resolveProps }, s.win, s.doc))!;

            await router.navigate("#part");

            const after = s.render.mock.calls.at(-1)![0];
            expect(after.props.location).toMatchObject({ hash: "#part", params: { id: "7" } });
            expect(after.props.children.props.children.props).toEqual({ id: "7" });
        });

        it("puts a full navigation's page on screen, with a fresh key, when it's a different route", async () => {
            const s = setup();
            const router = (await mountRouter(s.routes, { rootId: "react-root", prefix: "/admin" }, s.win, s.doc))!;
            s.win.fetch.mockResolvedValue({
                ok: true,
                redirected: false,
                headers: { get: () => "application/json" },
                json: async () => ({ route: "/users", props: { id: "9" }, css: [] }),
            });

            expect(await router.navigate("/admin/users")).toBe(true);

            expect(renderToString(s.render.mock.calls.at(-1)![0])).toBe("<p>id=9 path=/admin/users param=undefined</p>");
        });
    });

    describe("when a page crashes in the browser", () => {
        async function boundaryOnError() {
            const s = setup();
            await mountRouter(s.routes, { rootId: "react-root", prefix: "/admin" }, s.win, s.doc);
            const element: any = s.render.mock.calls[0][0];
            const boundary = element.props.children;
            return { s, boundary, onError: boundary.props.onError as (e: unknown) => void };
        }

        it("has the browser reload, once", async () => {
            const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const { s, onError } = await boundaryOnError();

            onError(new Error("render failed"));

            expect(error).toHaveBeenCalled();
            expect(s.win.sessionStorage.setItem).toHaveBeenCalledWith(RECOVERY_KEY, s.win.location.href);
            expect(s.win.location.reload).toHaveBeenCalledTimes(1);
        });

        it("doesn't try again for a URL it already tried, so it can't loop", async () => {
            vi.spyOn(console, "error").mockImplementation(() => undefined);
            const { s, onError } = await boundaryOnError();
            s.win.sessionStorage.getItem.mockReturnValue(s.win.location.href);

            onError(new Error("render failed"));

            expect(s.win.location.reload).not.toHaveBeenCalled();
        });

        it("still reloads when there's no sessionStorage to remember it in", async () => {
            vi.spyOn(console, "error").mockImplementation(() => undefined);
            const { s, onError } = await boundaryOnError();
            s.win.sessionStorage.getItem.mockImplementation(() => {
                throw new Error("denied");
            });

            onError(new Error("render failed"));

            expect(s.win.location.reload).toHaveBeenCalledTimes(1);
        });
    });

    describe("the listeners", () => {
        it("navigates on a click on a link to one of the app's pages, and not otherwise", async () => {
            const s = setup();
            const router = (await mountRouter(s.routes, { rootId: "react-root", prefix: "/admin" }, s.win, s.doc))!;
            const navigate = vi.spyOn(router, "navigate").mockResolvedValue(true);
            const onClick = s.docListeners.click[0];

            const plain = click(within(anchor({ href: "/admin/users/9" })));
            onClick(plain);
            expect(plain.preventDefault).toHaveBeenCalled();
            expect(navigate).toHaveBeenLastCalledWith("/admin/users/9", { replace: false });

            const shallow = click(within(anchor({ href: "/admin/users/9", "data-router-shallow": "" })));
            onClick(shallow);
            expect(navigate).toHaveBeenLastCalledWith("/admin/users/9", { replace: false, shallow: true });

            navigate.mockClear();
            for (const ignored of [click(within(anchor({ href: "/elsewhere" }))), click(within(anchor({ href: "/admin/users/9" })), { metaKey: true })]) {
                onClick(ignored);
                expect(ignored.preventDefault).not.toHaveBeenCalled();
            }
            expect(navigate).not.toHaveBeenCalled();
        });

        it("shows the page for where history went, on back and forward", async () => {
            const s = setup();
            const router = (await mountRouter(s.routes, { rootId: "react-root", prefix: "/admin" }, s.win, s.doc))!;
            const popstate = vi.spyOn(router, "popstate").mockResolvedValue(true);

            s.winListeners.popstate[0]({});

            expect(popstate).toHaveBeenCalled();
        });

        it("asks the browser to prompt before the page is left, only while a blocker is in force", async () => {
            const s = setup();
            const router = (await mountRouter(s.routes, { rootId: "react-root", prefix: "/admin" }, s.win, s.doc))!;
            const event = () => ({ preventDefault: vi.fn(), returnValue: undefined as any });

            const quiet = event();
            s.winListeners.beforeunload[0](quiet);
            expect(quiet.preventDefault).not.toHaveBeenCalled();

            router.block({ active: () => true });
            const asking = event();
            s.winListeners.beforeunload[0](asking);
            expect(asking.preventDefault).toHaveBeenCalled();
            expect(asking.returnValue).toBe("");
        });
    });

    describe("prefetching", () => {
        it("warms a plain link's page when it's pointed at, pressed on or focused, if asked to", async () => {
            const s = setup();
            const router = (await mountRouter(s.routes, { rootId: "react-root", prefix: "/admin", prefetch: { links: true } }, s.win, s.doc))!;
            const prefetch = vi.spyOn(router, "prefetch").mockImplementation(() => undefined);
            const target = (a: any) => ({ target: { closest: vi.fn(() => a) } });

            for (const type of ["pointerover", "pointerdown", "focusin"]) {
                s.docListeners[type][0](target(anchor({ href: "/admin/users/8" })));
            }

            expect(prefetch).toHaveBeenCalledTimes(3);
            expect(prefetch).toHaveBeenCalledWith("/admin/users/8");
        });

        it("doesn't warm plain links unless asked to", async () => {
            const s = setup();
            await mountRouter(s.routes, { rootId: "react-root", prefix: "/admin" }, s.win, s.doc);
            expect(s.docListeners.pointerover).toBeUndefined();
        });

        it("doesn't warm what isn't a link, one the router wouldn't take, or one that opted out of it", async () => {
            const s = setup();
            const router = (await mountRouter(s.routes, { rootId: "react-root", prefix: "/admin", prefetch: { links: true } }, s.win, s.doc))!;
            const prefetch = vi.spyOn(router, "prefetch").mockImplementation(() => undefined);
            const target = (a: any) => ({ target: { closest: vi.fn(() => a) } });
            const over = s.docListeners.pointerover[0];

            over(target(null));
            over(target(anchor({ href: "/x", target: "_blank" })));
            over(target(anchor({ href: "/x", "data-router-prefetch": "false" })));

            expect(prefetch).not.toHaveBeenCalled();
        });

        it("prefetches the listed pages' code (not their data) when the browser is idle", async () => {
            const s = setup();
            const router = (await mountRouter(
                s.routes,
                { rootId: "react-root", prefix: "/admin", prefetch: { idle: ["/admin/users", "/admin/users/9"] } },
                s.win,
                s.doc,
            ))!;
            const prefetch = vi.spyOn(router, "prefetch").mockImplementation(() => undefined);

            expect(s.win.setTimeout).toHaveBeenCalledTimes(1);
            s.timers[0]();

            expect(prefetch).toHaveBeenCalledWith("/admin/users", { data: false });
            expect(prefetch).toHaveBeenCalledWith("/admin/users/9", { data: false });
        });

        it("prefetches their data too when asked to", async () => {
            const s = setup();
            const router = (await mountRouter(
                s.routes,
                { rootId: "react-root", prefix: "/admin", prefetch: { idle: ["/admin/users"], data: true } },
                s.win,
                s.doc,
            ))!;
            const prefetch = vi.spyOn(router, "prefetch").mockImplementation(() => undefined);
            s.timers[0]();
            expect(prefetch).toHaveBeenCalledWith("/admin/users", { data: true });
        });

        it("does nothing when there's nothing listed, or when the user asked to save data", async () => {
            const none = setup();
            await mountRouter(none.routes, { rootId: "react-root", prefix: "/admin", prefetch: {} }, none.win, none.doc);
            expect(none.win.setTimeout).not.toHaveBeenCalled();

            const s2 = setup();
            await mountRouter(s2.routes, { rootId: "react-root", prefix: "/admin" }, s2.win, s2.doc);
            expect(s2.win.setTimeout).not.toHaveBeenCalled();

            const saving = setup();
            saving.win.navigator = { connection: { saveData: true } };
            await mountRouter(saving.routes, { rootId: "react-root", prefix: "/admin", prefetch: { idle: ["/admin/users"] } }, saving.win, saving.doc);
            expect(saving.win.setTimeout).not.toHaveBeenCalled();
        });
    });

    describe("scroll restoration", () => {
        it("puts the scroll position back when it was saved on the entry mounted on, and saves it on leaving", async () => {
            const s = setup();
            s.win.history.state = { rrScroll: { x: 3, y: 400 } };
            await mountRouter(s.routes, { rootId: "react-root", prefix: "/admin" }, s.win, s.doc);
            expect(s.win.scrollTo).toHaveBeenCalledWith(3, 400);

            s.win.history.state = { other: 1 };
            s.winListeners.pagehide[0]();
            expect(s.win.history.replaceState).toHaveBeenCalledWith({ other: 1, rrScroll: { x: 10, y: 20 } }, "");
        });

        it("leaves the scroll position alone on a page there's nothing saved for", async () => {
            const s = setup();
            await mountRouter(s.routes, { rootId: "react-root", prefix: "/admin" }, s.win, s.doc);
            expect(s.win.scrollTo).not.toHaveBeenCalled();
        });

        it("takes over scroll restoration, where the browser lets it be taken", async () => {
            const s = setup();
            await mountRouter(s.routes, { rootId: "react-root", prefix: "/admin" }, s.win, s.doc);
            expect(s.win.history.scrollRestoration).toBe("manual");

            const bare = setup();
            delete bare.win.history.scrollRestoration;
            await mountRouter(bare.routes, { rootId: "react-root", prefix: "/admin" }, bare.win, bare.doc);
            expect("scrollRestoration" in bare.win.history).toBe(false);
        });

        it("leaves the browser's scroll restoration, and the saved position, to the browser when scroll is false", async () => {
            const s = setup();
            s.win.history.state = { rrScroll: { x: 3, y: 400 } };
            await mountRouter(s.routes, { rootId: "react-root", prefix: "/admin", effects: { scroll: false } }, s.win, s.doc);
            expect(s.win.history.scrollRestoration).toBe("auto");
            expect(s.win.scrollTo).not.toHaveBeenCalled();
        });
    });
});
