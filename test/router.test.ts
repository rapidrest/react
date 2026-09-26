///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { vi } from "vitest";
import {
    createBrowserPlatform,
    readJsonScript,
    RECOVERY_KEY,
    startRouter,
    STYLESHEET_TIMEOUT_MS,
} from "../src/router.js";
import { usePathname, useParams } from "../src/routerContext.js";
import { NAVIGATION_HEADER, ROUTER_CONFIG_ID } from "../src/routerCore.js";

vi.mock("react-dom/client", () => ({ hydrateRoot: vi.fn() }));
vi.mock("react-dom", () => ({ flushSync: (fn: () => void) => fn() }));

const HREF = "https://example.com/admin/users/7?tab=1";

function makeWindow(href = HREF) {
    const listeners: Record<string, Array<(event: any) => void>> = {};
    const timers: Array<() => void> = [];
    const win: any = {
        location: { href, assign: vi.fn(), reload: vi.fn() },
        history: { state: null as any, scrollRestoration: "auto", pushState: vi.fn(), replaceState: vi.fn() },
        scrollX: 10,
        scrollY: 20,
        scrollTo: vi.fn(),
        fetch: vi.fn(),
        setTimeout: vi.fn((handler: () => void) => timers.push(handler)),
        addEventListener: vi.fn((type: string, handler: (event: any) => void) => {
            (listeners[type] ??= []).push(handler);
        }),
        sessionStorage: { getItem: vi.fn(() => null), setItem: vi.fn() },
    };
    return { win, listeners, timers };
}

function makeDocument(elements: Record<string, any> = {}) {
    const listeners: Record<string, Array<(event: any) => void>> = {};
    const links: any[] = [];
    const doc: any = {
        head: { appendChild: vi.fn((node: any) => links.push(node)) },
        createElement: vi.fn(() => ({})),
        getElementById: vi.fn((id: string) => elements[id] ?? null),
        querySelectorAll: vi.fn(() => links.filter((l) => l.rel === "stylesheet")),
        title: "before",
        addEventListener: vi.fn((type: string, handler: (event: any) => void) => {
            (listeners[type] ??= []).push(handler);
        }),
    };
    return { doc, listeners, links };
}

function makeContainer() {
    return { focus: vi.fn(), setAttribute: vi.fn(), style: { outline: "" }, scrollIntoView: vi.fn() };
}

describe("readJsonScript", () => {
    it("parses the JSON in a script element", () => {
        const { doc } = makeDocument({ x: { textContent: '{"a":1}' } });
        expect(readJsonScript(doc, "x")).toEqual({ a: 1 });
    });

    it("returns undefined when there's no such element, or its content isn't JSON", () => {
        const { doc } = makeDocument({ bad: { textContent: "not json" } });
        expect(readJsonScript(doc, "missing")).toBeUndefined();
        expect(readJsonScript(doc, "bad")).toBeUndefined();
    });
});

describe("createBrowserPlatform", () => {
    function setup(href = HREF, initialStyles?: string[]) {
        const { win, timers } = makeWindow(href);
        const { doc, links } = makeDocument();
        const container = makeContainer();
        const render = vi.fn();
        const platform = createBrowserPlatform(win, doc, container, render, initialStyles);
        return { win, doc, links, timers, container, render, platform };
    }

    it("makes the container focusable by script only, and not outlined", () => {
        const { container } = setup();
        expect(container.setAttribute).toHaveBeenCalledWith("tabindex", "-1");
        expect(container.style.outline).toBe("none");
    });

    it("reports the window's location as a URL, and hands rendering to what it was given", () => {
        const { platform, render } = setup();
        expect(platform.location().href).toBe(HREF);
        expect(platform.render).toBe(render);
    });

    describe("fetchPayload", () => {
        const response = (over: Record<string, any> = {}) => ({
            ok: true,
            redirected: false,
            headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json; charset=utf-8" : null) },
            json: async () => ({ route: "/users/:id", props: { id: "7" }, css: ["/a.css"] }),
            ...over,
        });
        const controller = () => new AbortController();

        it("asks for the page's data with the navigation header, on this origin's credentials", async () => {
            const { platform, win } = setup();
            win.fetch.mockResolvedValue(response());
            const signal = controller().signal;

            const payload = await platform.fetchPayload(new URL(HREF), signal);

            expect(payload).toEqual({ route: "/users/:id", props: { id: "7" }, css: ["/a.css"] });
            expect(win.fetch).toHaveBeenCalledWith(HREF, {
                headers: { [NAVIGATION_HEADER]: "1", Accept: "application/json" },
                credentials: "same-origin",
                signal,
            });
        });

        it("returns null for an error, a redirect, or something that isn't JSON — leaving the page to the browser", async () => {
            const { platform, win } = setup();
            for (const answer of [
                response({ ok: false }),
                response({ redirected: true }),
                response({ headers: { get: () => "text/html" } }),
                response({ headers: { get: () => null } }),
                response({ json: async () => ({ nope: true }) }),
            ]) {
                win.fetch.mockResolvedValueOnce(answer);
                expect(await platform.fetchPayload(new URL(HREF), controller().signal)).toBeNull();
            }
        });

        it("lets a failure to fetch or to parse the answer through, for the router to handle", async () => {
            const { platform, win } = setup();
            win.fetch.mockRejectedValueOnce(new TypeError("network down"));
            await expect(platform.fetchPayload(new URL(HREF), controller().signal)).rejects.toThrow("network down");

            win.fetch.mockResolvedValueOnce(response({ json: async () => Promise.reject(new SyntaxError("bad json")) }));
            await expect(platform.fetchPayload(new URL(HREF), controller().signal)).rejects.toThrow("bad json");
        });
    });

    describe("ensureStyles", () => {
        it("does nothing when every stylesheet is already there, however it was written", async () => {
            const { platform, links, doc } = setup();
            links.push({ rel: "stylesheet", href: "https://example.com/a.css" });

            await platform.ensureStyles(["/a.css", "https://example.com/a.css"]);

            expect(doc.head.appendChild).not.toHaveBeenCalled();
        });

        it("adds the ones that aren't, and waits for them", async () => {
            const { platform, links } = setup();
            links.push({ rel: "stylesheet", href: "https://example.com/a.css" });

            const done = platform.ensureStyles(["/a.css", "/b.css"]);
            expect(links).toHaveLength(2);
            expect(links[1]).toMatchObject({ rel: "stylesheet", href: "https://example.com/b.css" });

            let finished = false;
            void done.then(() => (finished = true));
            await Promise.resolve();
            expect(finished).toBe(false);

            links[1].onload();
            await done;
            expect(finished).toBe(true);
        });

        it("carries on when a stylesheet fails to load", async () => {
            const { platform, links } = setup();
            const done = platform.ensureStyles(["/b.css"]);
            links[0].onerror();
            await expect(done).resolves.toBeUndefined();
        });

        it("carries on when a stylesheet is taking too long", async () => {
            const { platform, timers, win } = setup();
            const done = platform.ensureStyles(["/b.css"]);
            expect(win.setTimeout).toHaveBeenCalledWith(expect.any(Function), STYLESHEET_TIMEOUT_MS);
            timers[0]();
            await expect(done).resolves.toBeUndefined();
        });
    });

    describe("pruneStyles", () => {
        const sheet = (href: string) => ({ rel: "stylesheet", href, remove: vi.fn() });

        it("removes the stylesheets the server put in for the first page when the next page doesn't need them", () => {
            const { platform, links } = setup(HREF, ["/first.css", "/shared.css"]);
            const [first, shared, layout] = [sheet("https://example.com/first.css"), sheet("https://example.com/shared.css"), sheet("https://example.com/layout.css")];
            links.push(first, shared, layout);

            platform.pruneStyles(["/shared.css", "/second.css"]);

            expect(first.remove).toHaveBeenCalled();
            expect(shared.remove).not.toHaveBeenCalled();
            // Not one of a page's: a layout's own stylesheet is never touched.
            expect(layout.remove).not.toHaveBeenCalled();
        });

        it("removes the ones a navigation added once a later page doesn't need them, and forgets them", async () => {
            const { platform, links } = setup();
            const done = platform.ensureStyles(["/added.css"]);
            links[0].onload();
            await done;
            links[0].remove = vi.fn();

            platform.pruneStyles(["/other.css"]);
            expect(links[0].remove).toHaveBeenCalledTimes(1);

            // Gone from the page, so it's no longer one of the page's to remove.
            platform.pruneStyles(["/other.css"]);
            expect(links[0].remove).toHaveBeenCalledTimes(1);
        });

        it("keeps a stylesheet the next page needs, however it's written", async () => {
            const { platform, links } = setup(HREF, ["/a.css"]);
            const a = sheet("https://example.com/a.css");
            links.push(a);
            platform.pruneStyles(["https://example.com/a.css"]);
            expect(a.remove).not.toHaveBeenCalled();
        });
    });

    describe("setTitle", () => {
        it("sets the document's title", () => {
            const { platform, doc } = setup();
            platform.setTitle("A page");
            expect(doc.title).toBe("A page");
        });
    });

    describe("history", () => {
        it("records the scroll position on the current entry, keeping what else is in its state", () => {
            const { platform, win } = setup();
            win.history.state = { other: 1 };
            platform.saveScroll();
            expect(win.history.replaceState).toHaveBeenCalledWith({ other: 1, rrScroll: { x: 10, y: 20 } }, "");

            win.history.state = null;
            platform.saveScroll();
            expect(win.history.replaceState).toHaveBeenLastCalledWith({ rrScroll: { x: 10, y: 20 } }, "");
        });

        it("adds or replaces an entry", () => {
            const { platform, win } = setup();
            const url = new URL("https://example.com/admin/users/8");

            platform.commitHistory(url, "push");
            expect(win.history.pushState).toHaveBeenCalledWith({}, "", url.href);

            platform.commitHistory(url, "replace");
            expect(win.history.replaceState).toHaveBeenCalledWith({}, "", url.href);
        });
    });

    describe("settle", () => {
        const url = (hash = "") => new URL("https://example.com/admin/users/8" + hash);

        it("scrolls to the top after a navigation, and focuses the page", () => {
            const { platform, win, container } = setup();
            platform.settle(url(), { restore: false, scroll: true });
            expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
            expect(container.focus).toHaveBeenCalledWith({ preventScroll: true });
        });

        it("scrolls to the #fragment's element when there is one, or the top when there isn't", () => {
            const { platform, win, doc } = setup();
            const target = { scrollIntoView: vi.fn() };
            doc.getElementById.mockReturnValueOnce(target);
            platform.settle(url("#sec%20one"), { restore: false, scroll: true });
            expect(doc.getElementById).toHaveBeenCalledWith("sec one");
            expect(target.scrollIntoView).toHaveBeenCalled();
            expect(win.scrollTo).not.toHaveBeenCalled();

            doc.getElementById.mockReturnValueOnce(null);
            platform.settle(url("#missing"), { restore: false, scroll: true });
            expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
        });

        it("treats a fragment with a malformed escape as having no element", () => {
            const { platform, win } = setup();
            platform.settle(url("#%E0%A4%A"), { restore: false, scroll: true });
            expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
        });

        it("restores the position saved on the entry when going back, and doesn't scroll otherwise", () => {
            const { platform, win } = setup();
            win.history.state = { rrScroll: { x: 5, y: 300 } };
            platform.settle(url(), { restore: true, scroll: true });
            expect(win.scrollTo).toHaveBeenCalledWith(5, 300);
            expect(win.scrollTo).toHaveBeenCalledTimes(1);
        });

        it("scrolls to the top when there's nothing saved to restore", () => {
            const { platform, win } = setup();
            platform.settle(url(), { restore: true, scroll: true });
            expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
        });

        it("leaves the scroll position alone when asked to", () => {
            const { platform, win, container } = setup();
            platform.settle(url(), { restore: false, scroll: false });
            expect(win.scrollTo).not.toHaveBeenCalled();
            expect(container.focus).toHaveBeenCalled();
        });
    });

    it("hands a page it can't navigate to the browser", () => {
        const { platform, win } = setup();
        platform.hardNavigate("https://example.com/elsewhere");
        expect(win.location.assign).toHaveBeenCalledWith("https://example.com/elsewhere");
    });
});

describe("startRouter", () => {
    const config = { prefix: "/admin", route: "/users/:id", rootId: "react-root", propsId: "react-props" };

    function Page(props: any) {
        return createElement("p", null, `id=${props.id} path=${usePathname()} param=${useParams().id}`);
    }

    function setup(over: { config?: any; container?: any; elements?: Record<string, any>; href?: string } = {}) {
        const container = over.container === undefined ? makeContainer() : over.container;
        const cfg = over.config === undefined ? config : over.config;
        const elements: Record<string, any> = {
            ...(cfg ? { [ROUTER_CONFIG_ID]: { textContent: JSON.stringify(cfg) } } : {}),
            [cfg?.rootId ?? "react-root"]: container,
            [cfg?.propsId ?? "react-props"]: { textContent: JSON.stringify({ id: "7" }) },
            ...over.elements,
        };
        if (!container) delete elements[cfg?.rootId ?? "react-root"];
        const { win, listeners: winListeners } = makeWindow(over.href);
        const { doc, listeners: docListeners, links } = makeDocument(elements);
        const load = vi.fn(async () => ({ default: Page }));
        const routes = [
            { template: "/users", load: vi.fn(async () => ({ default: Page })) },
            { template: "/users/:id", load },
        ];
        const render = vi.fn();
        vi.mocked(hydrateRoot).mockReturnValue({ render } as any);
        return { win, doc, winListeners, docListeners, links, routes, load, render, container };
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
        vi.mocked(hydrateRoot).mockReset();
    });

    it("does nothing without a browser to start in", async () => {
        expect(await startRouter([])).toBeUndefined();
    });

    it("says so, and does nothing, when the server didn't render a router page", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

        expect((await startRouter([], ...(Object.values(setup({ config: null })).slice(0, 2) as [any, any])))).toBeUndefined();
        const noRoot = setup({ container: null });
        expect(await startRouter([], noRoot.win, noRoot.doc)).toBeUndefined();

        expect(error).toHaveBeenCalledTimes(2);
        expect(error.mock.calls[0][0]).toContain("nothing to start on");
    });

    it("says so, and does nothing, when the page's route isn't one the client has", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const s = setup({ config: { ...config, route: "/nope" } });

        expect(await startRouter(s.routes, s.win, s.doc)).toBeUndefined();

        expect(error.mock.calls[0][0]).toContain('"/nope"');
        expect(hydrateRoot).not.toHaveBeenCalled();
    });

    it("hydrates the server's page into its root, from the props it embedded, with the router around it", async () => {
        const s = setup();

        const router = await startRouter(s.routes, s.win, s.doc);

        expect(router).toBeDefined();
        expect(s.load).toHaveBeenCalledTimes(1);
        expect(hydrateRoot).toHaveBeenCalledTimes(1);
        const [container, element] = vi.mocked(hydrateRoot).mock.calls[0];
        expect(container).toBe(s.container);
        // What the server rendered, inside the same provider: the location is available to the page, and matches.
        expect(renderToString(element as any)).toBe("<p>id=7 path=/admin/users/7 param=7</p>");
    });

    it("takes the first page's stylesheets out again, and follows the title, when it navigates to another page", async () => {
        const s = setup({ config: { ...config, css: ["/first.css"] } });
        const first = { rel: "stylesheet", href: "https://example.com/first.css", remove: vi.fn() };
        const layout = { rel: "stylesheet", href: "https://example.com/layout.css", remove: vi.fn() };
        s.links.push(first, layout);
        s.win.fetch.mockResolvedValue({
            ok: true,
            redirected: false,
            headers: { get: () => "application/json" },
            json: async () => ({ route: "/users", props: {}, css: [], title: "Users" }),
        });
        const router = await startRouter(s.routes, s.win, s.doc);

        expect(await router!.navigate("/admin/users")).toBe(true);

        expect(first.remove).toHaveBeenCalledTimes(1);
        expect(layout.remove).not.toHaveBeenCalled();
        expect(s.doc.title).toBe("Users");
    });

    it("hydrates a page at the mount root, and one outside its prefix, without a crash over the params", async () => {
        const s = setup({ config: { ...config, prefix: "/other" } });
        await startRouter(s.routes, s.win, s.doc);
        expect(renderToString(vi.mocked(hydrateRoot).mock.calls[0][1] as any)).toBe("<p>id=7 path=/admin/users/7 param=undefined</p>");
    });

    it("takes over scroll restoration, where the browser lets it be taken", async () => {
        const s = setup();
        await startRouter(s.routes, s.win, s.doc);
        expect(s.win.history.scrollRestoration).toBe("manual");

        const bare = setup();
        delete bare.win.history.scrollRestoration;
        await startRouter(bare.routes, bare.win, bare.doc);
        expect("scrollRestoration" in bare.win.history).toBe(false);
    });

    it("navigates on a click on a link to one of the app's pages, and not otherwise", async () => {
        const s = setup();
        const router = (await startRouter(s.routes, s.win, s.doc))!;
        const navigate = vi.spyOn(router, "navigate").mockResolvedValue(true);
        const onClick = s.docListeners.click[0];

        const plain = click(within(anchor({ href: "/admin/users/9" })));
        onClick(plain);
        expect(plain.preventDefault).toHaveBeenCalled();
        expect(navigate).toHaveBeenLastCalledWith("/admin/users/9", { replace: false });

        const replacing = click(within(anchor({ href: "/admin/users/9", "data-router-replace": "" })));
        onClick(replacing);
        expect(navigate).toHaveBeenLastCalledWith("/admin/users/9", { replace: true });

        navigate.mockClear();
        for (const ignored of [
            click(within(anchor({ href: "https://other.example/x" }))),
            click(within(anchor({ href: "/elsewhere" }))),
            click(within(anchor({ href: "/admin/users/9" })), { metaKey: true }),
            click(within(null)),
            click({}),
            click(null),
        ]) {
            onClick(ignored);
            expect(ignored.preventDefault).not.toHaveBeenCalled();
        }
        expect(navigate).not.toHaveBeenCalled();
    });

    it("shows the page for where history went, on back and forward", async () => {
        const s = setup();
        const router = (await startRouter(s.routes, s.win, s.doc))!;
        const popstate = vi.spyOn(router, "popstate").mockResolvedValue(true);

        s.winListeners.popstate[0]({});

        expect(popstate).toHaveBeenCalled();
    });

    it("puts a page on screen when navigating, with the location, params and props it was navigated to", async () => {
        const s = setup();
        const router = (await startRouter(s.routes, s.win, s.doc))!;
        s.win.fetch.mockResolvedValue({
            ok: true,
            redirected: false,
            headers: { get: () => "application/json" },
            json: async () => ({ route: "/users/:id", props: { id: "9" }, css: [] }),
        });
        s.win.location.href = "https://example.com/admin/users/7?tab=1";

        expect(await router.navigate("/admin/users/9")).toBe(true);

        expect(s.render).toHaveBeenCalledTimes(1);
        expect(renderToString(s.render.mock.calls[0][0])).toBe("<p>id=9 path=/admin/users/9 param=9</p>");
    });

    describe("when a page crashes in the browser", () => {
        async function boundaryOnError() {
            const s = setup();
            await startRouter(s.routes, s.win, s.doc);
            const element: any = vi.mocked(hydrateRoot).mock.calls[0][1];
            // RouterProvider > RouteBoundary > Page
            const boundary = element.props.children;
            return { s, boundary, onError: boundary.props.onError as (e: unknown) => void };
        }

        it("has the browser load the page, once, so the server can render it", async () => {
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

        it("renders nothing for the page that failed, and the page otherwise", async () => {
            const { boundary } = await boundaryOnError();
            const Boundary = boundary.type;
            const onError = vi.fn();

            const healthy = new Boundary({ onError, children: "child" });
            expect(healthy.render()).toBe("child");

            const failed = new Boundary({ onError, children: "child" });
            failed.state = Boundary.getDerivedStateFromError();
            expect(failed.render()).toBeNull();

            failed.componentDidCatch(new Error("x"));
            expect(onError).toHaveBeenCalledTimes(1);
        });
    });
});

describe("startRouter with the page's own globals", () => {
    it("uses the window and document it finds, when given none", async () => {
        const { win } = makeWindow();
        const container = makeContainer();
        const { doc } = makeDocument({
            [ROUTER_CONFIG_ID]: {
                textContent: JSON.stringify({ prefix: "", route: "/", rootId: "react-root", propsId: "react-props" }),
            },
            "react-root": container,
            "react-props": { textContent: "{}" },
        });
        vi.mocked(hydrateRoot).mockReturnValue({ render: vi.fn() } as any);
        (globalThis as any).window = win;
        (globalThis as any).document = doc;
        try {
            const router = await startRouter([{ template: "/", load: async () => ({ default: () => null }) }]);
            expect(router).toBeDefined();
            expect(hydrateRoot).toHaveBeenCalledTimes(1);
        } finally {
            delete (globalThis as any).window;
            delete (globalThis as any).document;
            vi.mocked(hydrateRoot).mockReset();
        }
    });
});
