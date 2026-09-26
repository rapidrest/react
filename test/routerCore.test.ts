///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { vi } from "vitest";
import {
    ClientRoute,
    ClickLike,
    compareTemplates,
    isHashChange,
    isInterceptableClick,
    isPagePayload,
    matchClientRoute,
    PagePayload,
    PREFETCH_TTL_MS,
    resolveTarget,
    Router,
    RouterPlatform,
    sortRoutes,
    stripPrefix,
} from "../src/routerCore.js";

const page = (name: string) => ({ default: name });
const route = (template: string): ClientRoute => ({ template, load: vi.fn(async () => page(template)) });

describe("compareTemplates / sortRoutes", () => {
    it("ranks a literal segment ahead of a :param at the first place they differ", () => {
        expect(compareTemplates("/users/new", "/users/:id")).toBeLessThan(0);
        expect(compareTemplates("/users/:id", "/users/new")).toBeGreaterThan(0);
        expect(compareTemplates("/a/:x/c", "/a/b/:y")).toBeGreaterThan(0);
    });

    it("treats templates with the same shape as equal, and orders otherwise by length", () => {
        expect(compareTemplates("/a/:x", "/a/:y")).toBe(0);
        expect(compareTemplates("/a/b", "/a/c")).toBe(0);
        expect(compareTemplates("/a", "/a/b")).toBeLessThan(0);
        expect(compareTemplates("/", "/a")).toBeLessThan(0);
    });

    it("sorts most specific first without changing the order of the rest, or mutating its input", () => {
        const input = [route("/users/:id"), route("/pets/:id"), route("/users/new"), route("/")];
        const sorted = sortRoutes(input);
        expect(sorted.map((r) => r.template)).toEqual(["/", "/users/new", "/users/:id", "/pets/:id"]);
        expect(input.map((r) => r.template)).toEqual(["/users/:id", "/pets/:id", "/users/new", "/"]);
    });
});

describe("stripPrefix", () => {
    it("returns the path unchanged when there is no prefix", () => {
        expect(stripPrefix("/users/1", "")).toBe("/users/1");
    });

    it("makes a path relative to the prefix, and the prefix itself the root", () => {
        expect(stripPrefix("/admin/users/1", "/admin")).toBe("/users/1");
        expect(stripPrefix("/admin", "/admin")).toBe("/");
        expect(stripPrefix("/admin/", "/admin")).toBe("/");
    });

    it("returns null for a path that isn't under the prefix, counting whole segments only", () => {
        expect(stripPrefix("/users", "/admin")).toBeNull();
        expect(stripPrefix("/adminx/users", "/admin")).toBeNull();
    });
});

describe("matchClientRoute", () => {
    const routes = sortRoutes([route("/"), route("/users"), route("/users/new"), route("/users/:id")]);

    it("matches a page and captures its params, decoded", () => {
        const match = matchClientRoute(routes, "/admin/users/a%20b", "/admin");
        expect(match?.route.template).toBe("/users/:id");
        expect(match?.params).toEqual({ id: "a b" });
    });

    it("prefers the literal route over a dynamic sibling", () => {
        expect(matchClientRoute(routes, "/admin/users/new", "/admin")?.route.template).toBe("/users/new");
    });

    it("matches the mount root", () => {
        expect(matchClientRoute(routes, "/admin", "/admin")?.route.template).toBe("/");
        expect(matchClientRoute(routes, "/", "")?.route.template).toBe("/");
    });

    it("returns null outside the prefix, and for a path no route serves", () => {
        expect(matchClientRoute(routes, "/other/users", "/admin")).toBeNull();
        expect(matchClientRoute(routes, "/admin/nope/nothing", "/admin")).toBeNull();
    });
});

describe("resolveTarget", () => {
    const base = "https://example.com/admin/users?a=1";

    it("resolves relative and same-origin absolute URLs", () => {
        expect(resolveTarget("/admin/pets", base)?.href).toBe("https://example.com/admin/pets");
        expect(resolveTarget("pets?x=2#top", base)?.href).toBe("https://example.com/admin/pets?x=2#top");
        expect(resolveTarget("https://example.com/x", base)?.pathname).toBe("/x");
    });

    it("returns null for another origin, another protocol, or something that isn't a URL", () => {
        expect(resolveTarget("https://evil.example/x", base)).toBeNull();
        expect(resolveTarget("http://example.com/x", base)).toBeNull();
        expect(resolveTarget("mailto:a@example.com", base)).toBeNull();
        expect(resolveTarget("javascript:alert(1)", base)).toBeNull();
        expect(resolveTarget("http://[", base)).toBeNull();
        expect(resolveTarget("/x", "not a url")).toBeNull();
    });
});

describe("isHashChange", () => {
    const current = new URL("https://example.com/a?x=1#one");

    it("is true only for a different #fragment of the same page", () => {
        expect(isHashChange(new URL("https://example.com/a?x=1#two"), current)).toBe(true);
    });

    it("is false for the same fragment, no fragment, another path, or another query", () => {
        expect(isHashChange(new URL("https://example.com/a?x=1#one"), current)).toBe(false);
        expect(isHashChange(new URL("https://example.com/a?x=1"), current)).toBe(false);
        expect(isHashChange(new URL("https://example.com/b?x=1#two"), current)).toBe(false);
        expect(isHashChange(new URL("https://example.com/a?x=2#two"), current)).toBe(false);
    });
});

describe("isInterceptableClick", () => {
    const click = (over: Partial<ClickLike> = {}): ClickLike => ({
        defaultPrevented: false,
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        ...over,
    });
    const anchor = (attrs: Record<string, string> = { href: "/x" }) => ({
        getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
        hasAttribute: (name: string) => name in attrs,
    });

    it("takes an ordinary click on a link", () => {
        expect(isInterceptableClick(click(), anchor())).toBe(true);
        expect(isInterceptableClick(click(), anchor({ href: "/x", target: "_self" }))).toBe(true);
        expect(isInterceptableClick(click(), anchor({ href: "/x", rel: "noopener nofollow" }))).toBe(true);
    });

    it("leaves everything else to the browser", () => {
        expect(isInterceptableClick(click(), null)).toBe(false);
        expect(isInterceptableClick(click({ defaultPrevented: true }), anchor())).toBe(false);
        expect(isInterceptableClick(click({ button: 1 }), anchor())).toBe(false);
        for (const key of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
            expect(isInterceptableClick(click({ [key]: true }), anchor())).toBe(false);
        }
        expect(isInterceptableClick(click(), anchor({}))).toBe(false);
        expect(isInterceptableClick(click(), anchor({ href: "/x", target: "_blank" }))).toBe(false);
        expect(isInterceptableClick(click(), anchor({ href: "/x", download: "" }))).toBe(false);
        expect(isInterceptableClick(click(), anchor({ href: "/x", "data-router-ignore": "" }))).toBe(false);
        expect(isInterceptableClick(click(), anchor({ href: "/x", rel: "noopener external" }))).toBe(false);
    });
});

describe("isPagePayload", () => {
    it("accepts a well-formed payload, whatever the props are", () => {
        expect(isPagePayload({ route: "/a", props: {}, css: ["/a.css"] })).toBe(true);
        expect(isPagePayload({ route: "/a", props: null, css: [] })).toBe(true);
    });

    it("rejects anything else", () => {
        expect(isPagePayload(null)).toBe(false);
        expect(isPagePayload("html")).toBe(false);
        expect(isPagePayload({ props: {}, css: [] })).toBe(false);
        expect(isPagePayload({ route: "/a", css: [] })).toBe(false);
        expect(isPagePayload({ route: "/a", props: {} })).toBe(false);
        expect(isPagePayload({ route: "/a", props: {}, css: [1] })).toBe(false);
    });
});

describe("Router", () => {
    const ORIGIN = "https://example.com";
    let current: URL;
    let platform: RouterPlatform;
    let fetchPayload: ReturnType<typeof vi.fn>;
    let now = 0;
    let routes: ClientRoute[];

    const payloadFor = (template: string, props: any = {}, css: string[] = []): PagePayload => ({
        route: template,
        props,
        css,
    });

    function router(prefix = "/admin") {
        return new Router(routes, prefix, platform, () => now);
    }

    beforeEach(() => {
        now = 0;
        current = new URL(ORIGIN + "/admin/users");
        routes = [route("/"), route("/users"), route("/users/new"), route("/users/:id")];
        fetchPayload = vi.fn(async (url: URL) => {
            const match = /\/users\/(\w+)$/.exec(url.pathname);
            return match && match[1] !== "new"
                ? payloadFor("/users/:id", { id: match[1] }, ["/a.css"])
                : payloadFor(url.pathname.endsWith("/new") ? "/users/new" : "/users");
        });
        platform = {
            location: () => current,
            fetchPayload: fetchPayload as any,
            ensureStyles: vi.fn(async () => undefined),
            render: vi.fn(),
            saveScroll: vi.fn(),
            commitHistory: vi.fn((url: URL) => {
                current = url;
            }),
            settle: vi.fn(),
            hardNavigate: vi.fn(),
        };
    });

    describe("canHandle", () => {
        it("is true for one of the app's pages", () => {
            expect(router().canHandle("/admin/users/7")).toBe(true);
            expect(router().canHandle("users/new")).toBe(true);
        });

        it("is false for another origin, another app, an unknown page, or a #fragment of this one", () => {
            expect(router().canHandle("https://other.example/admin/users")).toBe(false);
            expect(router().canHandle("/elsewhere")).toBe(false);
            expect(router().canHandle("/admin/nope/nope")).toBe(false);
            expect(router().canHandle("#section")).toBe(false);
        });
    });

    describe("navigate", () => {
        it("loads the page's module and data together, and puts it on screen", async () => {
            const result = await router().navigate("/admin/users/7");

            expect(result).toBe(true);
            expect(fetchPayload).toHaveBeenCalledTimes(1);
            expect(fetchPayload.mock.calls[0][0].href).toBe(ORIGIN + "/admin/users/7");
            expect(fetchPayload.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
            expect(routes[3].load).toHaveBeenCalledTimes(1);
            expect(platform.ensureStyles).toHaveBeenCalledWith(["/a.css"]);
            expect(platform.saveScroll).toHaveBeenCalled();
            expect(platform.commitHistory).toHaveBeenCalledWith(expect.objectContaining({ href: ORIGIN + "/admin/users/7" }), "push");
            expect(platform.render).toHaveBeenCalledWith({
                component: "/users/:id",
                props: { id: "7" },
                url: expect.objectContaining({ pathname: "/admin/users/7" }),
                params: { id: "7" },
                route: "/users/:id",
            });
            expect(platform.settle).toHaveBeenCalledWith(expect.anything(), { restore: false, scroll: true });
            expect(platform.hardNavigate).not.toHaveBeenCalled();
        });

        it("updates the history entry in place when asked to, or when it's the page already showing", async () => {
            await router().navigate("/admin/users/7", { replace: true });
            expect(platform.commitHistory).toHaveBeenLastCalledWith(expect.anything(), "replace");

            await router().navigate("/admin/users/7");
            expect(platform.commitHistory).toHaveBeenLastCalledWith(expect.anything(), "replace");
        });

        it("leaves the scroll position alone when asked to", async () => {
            await router().navigate("/admin/users/7", { scroll: false });
            expect(platform.settle).toHaveBeenCalledWith(expect.anything(), { restore: false, scroll: false });
        });

        it("has the browser load anything that isn't one of the app's pages, the ordinary way", async () => {
            expect(await router().navigate("https://other.example/x")).toBe(false);
            expect(platform.hardNavigate).toHaveBeenLastCalledWith("https://other.example/x");

            expect(await router().navigate("/elsewhere")).toBe(false);
            expect(platform.hardNavigate).toHaveBeenLastCalledWith(ORIGIN + "/elsewhere");
            expect(fetchPayload).not.toHaveBeenCalled();
            expect(platform.render).not.toHaveBeenCalled();
        });

        it("has the browser load the page when the server didn't answer with a page payload", async () => {
            fetchPayload.mockResolvedValueOnce(null);
            expect(await router().navigate("/admin/users/7")).toBe(false);
            expect(platform.hardNavigate).toHaveBeenCalledWith(ORIGIN + "/admin/users/7");
            expect(platform.render).not.toHaveBeenCalled();
            expect(platform.commitHistory).not.toHaveBeenCalled();
        });

        it("has the browser load the page when the server resolved it to a different route than the client did", async () => {
            fetchPayload.mockResolvedValueOnce(payloadFor("/users"));
            expect(await router().navigate("/admin/users/7")).toBe(false);
            expect(platform.hardNavigate).toHaveBeenCalledWith(ORIGIN + "/admin/users/7");
            expect(platform.render).not.toHaveBeenCalled();
        });

        it("has the browser load the page when fetching its data fails", async () => {
            fetchPayload.mockRejectedValueOnce(new TypeError("network down"));
            expect(await router().navigate("/admin/users/7")).toBe(false);
            expect(platform.hardNavigate).toHaveBeenCalledWith(ORIGIN + "/admin/users/7");
        });

        it("has the browser load the page when its module fails to load", async () => {
            (routes[3].load as any).mockRejectedValueOnce(new Error("chunk 404"));
            expect(await router().navigate("/admin/users/7")).toBe(false);
            expect(platform.hardNavigate).toHaveBeenCalledWith(ORIGIN + "/admin/users/7");
            expect(platform.render).not.toHaveBeenCalled();
        });

        it("doesn't remember a failed page as if it were one", async () => {
            fetchPayload.mockRejectedValueOnce(new TypeError("network down"));
            const r = router();
            await r.navigate("/admin/users/7");
            fetchPayload.mockClear();

            expect(await r.navigate("/admin/users/7")).toBe(true);
            expect(fetchPayload).toHaveBeenCalledTimes(1);
        });

        it("lets a newer navigation win, and aborts the older one's request", async () => {
            let releaseFirst!: (p: PagePayload) => void;
            const signals: AbortSignal[] = [];
            fetchPayload.mockImplementation((url: URL, signal: AbortSignal) => {
                signals.push(signal);
                if (url.pathname.endsWith("/1")) {
                    return new Promise<PagePayload>((resolve) => (releaseFirst = resolve));
                }
                return Promise.resolve(payloadFor("/users/:id", { id: "2" }));
            });
            const r = router();

            const first = r.navigate("/admin/users/1");
            const second = r.navigate("/admin/users/2");
            expect(await second).toBe(true);
            releaseFirst(payloadFor("/users/:id", { id: "1" }));

            // The older one is over, having been overtaken — it isn't a failure, and it never reaches the screen.
            expect(await first).toBe(true);
            expect(signals[0].aborted).toBe(true);
            expect(signals[1].aborted).toBe(false);
            expect(platform.render).toHaveBeenCalledTimes(1);
            expect(platform.render).toHaveBeenCalledWith(expect.objectContaining({ props: { id: "2" } }));
            expect(platform.hardNavigate).not.toHaveBeenCalled();
        });

        it("doesn't treat the failure of an overtaken navigation as a reason to load its page", async () => {
            let rejectFirst!: (e: Error) => void;
            fetchPayload.mockImplementation((url: URL) =>
                url.pathname.endsWith("/1")
                    ? new Promise<PagePayload>((_, reject) => (rejectFirst = reject))
                    : Promise.resolve(payloadFor("/users/:id", { id: "2" })),
            );
            const r = router();

            const first = r.navigate("/admin/users/1");
            await r.navigate("/admin/users/2");
            rejectFirst(new DOMException("aborted", "AbortError"));

            expect(await first).toBe(true);
            expect(platform.hardNavigate).not.toHaveBeenCalled();
        });

        it("drops a navigation that was overtaken while its stylesheets were loading", async () => {
            let releaseStyles!: () => void;
            (platform.ensureStyles as any).mockImplementationOnce(() => new Promise<void>((resolve) => (releaseStyles = resolve)));
            const r = router();

            const first = r.navigate("/admin/users/1");
            await vi.waitFor(() => expect(platform.ensureStyles).toHaveBeenCalledTimes(1));
            const second = r.navigate("/admin/users/2");
            await second;
            releaseStyles();

            expect(await first).toBe(true);
            expect(platform.render).toHaveBeenCalledTimes(1);
            expect(platform.render).toHaveBeenCalledWith(expect.objectContaining({ props: { id: "2" } }));
        });
    });

    describe("popstate", () => {
        it("shows the page for where history went, without adding an entry, and restores its scroll position", async () => {
            current = new URL(ORIGIN + "/admin/users/7");

            expect(await router().popstate()).toBe(true);

            expect(platform.commitHistory).not.toHaveBeenCalled();
            expect(platform.render).toHaveBeenCalledWith(expect.objectContaining({ props: { id: "7" } }));
            expect(platform.settle).toHaveBeenCalledWith(expect.anything(), { restore: true, scroll: true });
        });

        it("has the browser load a page that isn't one of the app's", async () => {
            current = new URL(ORIGIN + "/elsewhere");
            expect(await router().popstate()).toBe(false);
            expect(platform.hardNavigate).toHaveBeenCalledWith(ORIGIN + "/elsewhere");
        });
    });

    describe("prefetch", () => {
        it("fetches the page ahead of time, so navigating to it needn't wait for another request", async () => {
            const r = router();
            r.prefetch("/admin/users/7");
            expect(fetchPayload).toHaveBeenCalledTimes(1);
            expect(routes[3].load).toHaveBeenCalledTimes(1);

            expect(await r.navigate("/admin/users/7")).toBe(true);

            expect(fetchPayload).toHaveBeenCalledTimes(1);
            expect(routes[3].load).toHaveBeenCalledTimes(1);
            expect(platform.render).toHaveBeenCalledWith(expect.objectContaining({ props: { id: "7" } }));
        });

        it("doesn't fetch the same page again while it's fresh, but does once it's stale", async () => {
            const r = router();
            r.prefetch("/admin/users/7");
            now += PREFETCH_TTL_MS - 1;
            r.prefetch("/admin/users/7");
            expect(fetchPayload).toHaveBeenCalledTimes(1);

            now += 1;
            r.prefetch("/admin/users/7");
            expect(fetchPayload).toHaveBeenCalledTimes(2);
        });

        it("isn't used by a navigation that comes after it's stale", async () => {
            const r = router();
            r.prefetch("/admin/users/7");
            now += PREFETCH_TTL_MS;

            await r.navigate("/admin/users/7");

            expect(fetchPayload).toHaveBeenCalledTimes(2);
        });

        it("does nothing for anything navigate() wouldn't handle", () => {
            const r = router();
            r.prefetch("https://other.example/admin/users");
            r.prefetch("/elsewhere");
            expect(fetchPayload).not.toHaveBeenCalled();
        });

        it("forgets a page it couldn't fetch, without reporting it as unhandled, so it's tried again", async () => {
            fetchPayload.mockRejectedValueOnce(new TypeError("network down"));
            (routes[3].load as any).mockRejectedValueOnce(new Error("chunk 404"));
            const r = router();
            r.prefetch("/admin/users/7");
            await new Promise((resolve) => setTimeout(resolve, 0));

            r.prefetch("/admin/users/7");
            expect(fetchPayload).toHaveBeenCalledTimes(2);
        });

        it("keeps a newer prefetch when an older one fails", async () => {
            let rejectOld!: (e: Error) => void;
            fetchPayload.mockImplementationOnce(() => new Promise((_, reject) => (rejectOld = reject)));
            const r = router();
            r.prefetch("/admin/users/7");
            now += PREFETCH_TTL_MS;
            r.prefetch("/admin/users/7"); // stale, so replaced by a newer entry
            expect(fetchPayload).toHaveBeenCalledTimes(2);

            rejectOld(new Error("old failed"));
            await new Promise((resolve) => setTimeout(resolve, 0));

            r.prefetch("/admin/users/7"); // the newer entry is still there, fresh
            expect(fetchPayload).toHaveBeenCalledTimes(2);
        });

        it("doesn't keep a page around once it's been navigated to", async () => {
            const r = router();
            await r.navigate("/admin/users/7");
            fetchPayload.mockClear();

            await r.navigate("/admin/users/7");

            expect(fetchPayload).toHaveBeenCalledTimes(1);
        });
    });
});
