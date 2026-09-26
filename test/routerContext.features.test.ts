///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { vi } from "vitest";
import {
    createSearchParams,
    isLinkActive,
    Link,
    linkHandlers,
    NavLink,
    RouterApi,
    RouterLocation,
    RouterProvider,
    useLocation,
    useMatch,
    useParams,
    useRouter,
    useSearchParams,
} from "../src/routerContext.js";

/*
 * The location hooks and links, rendered on the server (where what they render has to be what the browser hydrates), and
 * called with a router that's a fake — what they ask of it is what they're about.
 */

const LOCATION: RouterLocation = {
    pathname: "/admin/pets/7",
    search: "?tab=1&tag=a&tag=b",
    hash: "",
    params: { id: "7" },
    route: "/pets/:id",
};

function fakeApi(over: Partial<RouterApi> = {}): RouterApi {
    return {
        navigate: vi.fn(async () => true),
        prefetch: vi.fn(),
        canHandle: vi.fn(() => true),
        block: vi.fn(() => () => undefined),
        addEffects: vi.fn(() => () => undefined),
        currentUrl: vi.fn(() => new URL("https://example.com/admin/pets/7?tab=1&tag=a&tag=b#top")),
        isPending: vi.fn(() => true),
        subscribePending: vi.fn(() => () => undefined),
        ...over,
    };
}

function renderAndCapture<T>(fn: () => T, provider?: { location: Partial<RouterLocation> & Pick<RouterLocation, "pathname" | "search" | "params" | "route">; api?: RouterApi | null }): { html: string; value: T } {
    let value!: T;
    const Capture = () => {
        value = fn();
        return null;
    };
    const tree: ReactElement = provider ? createElement(RouterProvider, provider, createElement(Capture)) : createElement(Capture);
    const html = renderToString(tree);
    return { html, value };
}

const html = (element: ReactElement, location: Partial<RouterLocation> = {}, api: RouterApi | null = null) =>
    renderToString(createElement(RouterProvider, { location: { ...LOCATION, ...location }, api }, element));

describe("useRouter", () => {
    it("reports the fragment (empty on the server, which is never sent one), and that nothing is pending there", () => {
        const { value } = renderAndCapture(() => useRouter(), { location: { pathname: "/x", search: "", params: {}, route: "/x" }, api: fakeApi() });
        expect(value.hash).toBe("");
        // The server renders what the browser hydrates: not pending, whatever the router says by then.
        expect(value.pending).toBe(false);
    });

    it("reports a fragment the provider was given", () => {
        const { value } = renderAndCapture(() => useRouter(), { location: { ...LOCATION, hash: "#top" } });
        expect(value.hash).toBe("#top");
    });

    it("passes everything a page gives prefetch() on to the router", () => {
        const api = fakeApi();
        const { value } = renderAndCapture(() => useRouter(), { location: LOCATION, api });
        value.prefetch("/x", { data: false });
        expect(api.prefetch).toHaveBeenCalledWith("/x", { data: false });
    });

    it("outside any router has no fragment and nothing pending", () => {
        expect(renderAndCapture(() => useRouter()).value).toMatchObject({ hash: "", pending: false });
    });
});

describe("useLocation", () => {
    it("gives the path, the query and the fragment", () => {
        const { value } = renderAndCapture(() => useLocation(), { location: { ...LOCATION, hash: "#top" } });
        expect(value).toEqual({ pathname: "/admin/pets/7", search: "?tab=1&tag=a&tag=b", hash: "#top" });
    });

    it("is nowhere in particular outside a router", () => {
        expect(renderAndCapture(() => useLocation()).value).toEqual({ pathname: "", search: "", hash: "" });
    });

    it("stays the same object while the location does, however the router re-renders", () => {
        const seen: unknown[] = [];
        const Capture = () => (seen.push(useLocation()), null);
        renderToString(createElement(RouterProvider, { location: LOCATION }, createElement(Capture)));
        expect(seen).toHaveLength(1);
    });
});

describe("createSearchParams", () => {
    it("takes what URLSearchParams takes", () => {
        expect(createSearchParams("a=1&b=2").toString()).toBe("a=1&b=2");
        expect(createSearchParams(new URLSearchParams("a=1")).toString()).toBe("a=1");
        expect(createSearchParams([["a", "1"], ["a", "2"]]).toString()).toBe("a=1&a=2");
    });

    it("takes an object, whose lists become repeated keys and whose undefined values are left out", () => {
        expect(createSearchParams({ a: "1", tag: ["x", "y"], gone: undefined }).toString()).toBe("a=1&tag=x&tag=y");
    });
});

describe("useSearchParams", () => {
    it("gives the query the page was rendered with", () => {
        const { value } = renderAndCapture(() => useSearchParams(), { location: LOCATION });
        expect(value[0].get("tab")).toBe("1");
        expect(value[0].getAll("tag")).toEqual(["a", "b"]);
    });

    it("gives an empty query outside a router", () => {
        expect(renderAndCapture(() => useSearchParams()).value[0].toString()).toBe("");
    });

    it("goes to the same page with the new query, keeping the path and the fragment, without remounting the page", () => {
        const api = fakeApi();
        const { value } = renderAndCapture(() => useSearchParams(), { location: LOCATION, api });

        value[1]({ tab: "2" });

        expect(api.navigate).toHaveBeenCalledWith("/admin/pets/7?tab=2#top", {
            replace: undefined,
            scroll: undefined,
            refetch: undefined,
            shallow: true,
        });
    });

    it("passes on what it's told about the history entry, and lets the page ask for a full navigation", () => {
        const api = fakeApi();
        const { value } = renderAndCapture(() => useSearchParams(), { location: LOCATION, api });

        value[1]("q=1", { replace: true, shallow: false, refetch: true, scroll: false });

        expect(api.navigate).toHaveBeenCalledWith("/admin/pets/7?q=1#top", { replace: true, scroll: false, refetch: true, shallow: false });
    });

    it("builds the new query from the browser's current one with a function, and can empty it", () => {
        const api = fakeApi();
        const { value } = renderAndCapture(() => useSearchParams(), { location: LOCATION, api });

        value[1]((previous) => ({ page: String(Number(previous.get("tab")) + 1) }));
        expect(api.navigate).toHaveBeenLastCalledWith("/admin/pets/7?page=2#top", expect.anything());

        value[1](() => new URLSearchParams());
        expect(api.navigate).toHaveBeenLastCalledWith("/admin/pets/7#top", expect.anything());
    });

    it("has nowhere to navigate outside a router but the page load, which needs a window", async () => {
        const { value } = renderAndCapture(() => useSearchParams());
        expect(() => value[1]({ a: "1" })).not.toThrow();
        await Promise.resolve();
    });

    it("uses the browser's location outside a router, when there's a window", async () => {
        const assign = vi.fn();
        (globalThis as any).window = { location: { assign, href: "https://example.com/here?x=1" } };
        try {
            const { value } = renderAndCapture(() => useSearchParams());
            value[1]((previous) => ({ ...Object.fromEntries(previous), y: "2" }));
            await Promise.resolve();
            expect(assign).toHaveBeenCalledWith("/here?x=1&y=2");
        } finally {
            delete (globalThis as any).window;
        }
    });
});

describe("useMatch", () => {
    it("matches the path against a pattern, with what it captured", () => {
        expect(renderAndCapture(() => useMatch("/admin/pets/:id"), { location: LOCATION }).value).toEqual({
            params: { id: "7" },
            pathname: "/admin/pets/7",
        });
        expect(renderAndCapture(() => useMatch("/admin/*"), { location: LOCATION }).value?.params).toEqual({ "*": "pets/7" });
    });

    it("is null when it doesn't, and matches only the start of the path with end: false", () => {
        expect(renderAndCapture(() => useMatch("/admin/pets"), { location: LOCATION }).value).toBeNull();
        expect(renderAndCapture(() => useMatch("/admin/pets", { end: false }), { location: LOCATION }).value).not.toBeNull();
    });
});

describe("useParams", () => {
    it("is still there", () => {
        expect(renderAndCapture(() => useParams(), { location: LOCATION }).value).toEqual({ id: "7" });
    });
});

describe("isLinkActive", () => {
    const at = (pathname: string, search = "") => ({ pathname, search });

    it("is active on the link's path, and on the pages below it unless `end`", () => {
        expect(isLinkActive("/settings", at("/settings"))).toBe(true);
        expect(isLinkActive("/settings", at("/settings/profile"))).toBe(true);
        expect(isLinkActive("/settings", at("/settings/profile"), { end: true })).toBe(false);
        expect(isLinkActive("/settings/", at("/settings"), { end: true })).toBe(true);
    });

    it("counts whole segments only, and never a page above the link", () => {
        expect(isLinkActive("/settings", at("/settingsx"))).toBe(false);
        expect(isLinkActive("/settings/profile", at("/settings"))).toBe(false);
        expect(isLinkActive("/settings/profile", at("/settings/other"))).toBe(false);
    });

    it("is active on the root only when the page is the root", () => {
        expect(isLinkActive("/", at("/"))).toBe(true);
        expect(isLinkActive("/", at("/settings"))).toBe(false);
    });

    it("resolves a relative link against where the page is", () => {
        expect(isLinkActive("profile", at("/settings/account"))).toBe(false);
        expect(isLinkActive("account", at("/settings/account"))).toBe(true);
        expect(isLinkActive("?folder=b", at("/mail", "?folder=a"))).toBe(true);
        expect(isLinkActive("?folder=b", at("/mail", "?folder=a"), { matchQuery: true })).toBe(false);
        expect(isLinkActive("", at("/mail"))).toBe(true);
    });

    it("compares paths as decoded, and ignores the fragment and (by default) the query", () => {
        expect(isLinkActive("/caf%C3%A9", at("/café"))).toBe(true);
        expect(isLinkActive("/a%zz", at("/a%zz"))).toBe(true);
        expect(isLinkActive("/mail?folder=a#x", at("/mail", "?folder=b"))).toBe(true);
    });

    it("with matchQuery, needs every one of the link's query parameters to be in the page's", () => {
        const options = { matchQuery: true };
        expect(isLinkActive("/mail?folder=a", at("/mail", "?folder=a&x=1"), options)).toBe(true);
        expect(isLinkActive("/mail?folder=a", at("/mail", "?folder=b"), options)).toBe(false);
        expect(isLinkActive("/mail?folder=a", at("/mail"), options)).toBe(false);
        expect(isLinkActive("/mail?t=1&t=2", at("/mail", "?t=2&t=1"), options)).toBe(true);
        expect(isLinkActive("/mail", at("/mail", "?folder=b"), options)).toBe(true);
    });

    it("is never active for a link to another site, or one that isn't a URL", () => {
        expect(isLinkActive("https://other.example/mail", at("/mail"))).toBe(false);
        expect(isLinkActive("http://[", at("/mail"))).toBe(false);
    });
});

describe("Link", () => {
    it("passes shallow and refetch on to the router, and marks itself as one not to prefetch when it's asked not to", () => {
        const api = fakeApi();
        const { value } = renderAndCapture(
            () => Link({ href: "/admin/pets/7?tab=2", shallow: true, refetch: true, prefetch: false, children: "x" }),
            { location: LOCATION, api },
        );
        expect(value.props["data-router-prefetch"]).toBe("false");
        (value.props as any).onClick({
            defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
            preventDefault: vi.fn(),
            currentTarget: { getAttribute: (n: string) => (n === "href" ? "/x" : null), hasAttribute: () => false },
        });
        expect(api.navigate).toHaveBeenCalledWith("/admin/pets/7?tab=2", { replace: undefined, scroll: undefined, shallow: true, refetch: true });
    });

    it("has no such mark otherwise", () => {
        expect(html(createElement(Link, { href: "/a" }, "A"))).toBe('<a href="/a">A</a>');
    });

    it("hands linkHandlers everything a link can be told", () => {
        const api = fakeApi();
        const event: any = {
            defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
            preventDefault: vi.fn(),
            currentTarget: { getAttribute: (n: string) => (n === "href" ? "/x" : null), hasAttribute: () => false },
        };
        linkHandlers({ api, href: "/x", shallow: true, refetch: true, replace: true, scroll: false, prefetch: true }, {}).onClick(event);
        expect(api.navigate).toHaveBeenCalledWith("/x", { replace: true, scroll: false, shallow: true, refetch: true });
    });
});

describe("NavLink", () => {
    it("has aria-current=\"page\" (and the active class) on the server, when it goes to where the page is", () => {
        const active = html(createElement(NavLink, { href: "/admin/pets", activeClassName: "on", className: "nav" }, "Pets"));
        expect(active).toBe('<a class="nav on" aria-current="page" href="/admin/pets">Pets</a>');
    });

    it("has neither when it goes somewhere else", () => {
        expect(html(createElement(NavLink, { href: "/admin/owners", activeClassName: "on", className: "nav" }, "Owners"))).toBe(
            '<a class="nav" href="/admin/owners">Owners</a>',
        );
        expect(html(createElement(NavLink, { href: "/admin/owners", activeClassName: "on" }, "Owners"))).toBe('<a href="/admin/owners">Owners</a>');
    });

    it("has only the active class when it has no class of its own", () => {
        expect(html(createElement(NavLink, { href: "/admin/pets", activeClassName: "on" }, "Pets"))).toContain('class="on"');
    });

    it("takes a function for its class name, given whether it's active", () => {
        const className = ({ active }: { active: boolean }) => (active ? "yes" : undefined);
        expect(html(createElement(NavLink, { href: "/admin/pets", className }, "Pets"))).toContain('class="yes"');
        expect(html(createElement(NavLink, { href: "/admin/owners", className }, "O"))).toBe('<a href="/admin/owners">O</a>');
    });

    it("is active on the pages below its own unless `end` is set", () => {
        expect(html(createElement(NavLink, { href: "/admin" }, "Admin"))).toContain('aria-current="page"');
        expect(html(createElement(NavLink, { href: "/admin", end: true }, "Admin"))).not.toContain("aria-current");
    });

    it("can be told to look at the query too", () => {
        expect(html(createElement(NavLink, { href: "/admin/pets/7?tab=1", matchQuery: true }, "T"))).toContain('aria-current="page"');
        expect(html(createElement(NavLink, { href: "/admin/pets/7?tab=9", matchQuery: true }, "T"))).not.toContain("aria-current");
    });

    it("keeps an aria-current it was given: as the active value when active, as it was when not", () => {
        expect(html(createElement(NavLink, { href: "/admin/pets", "aria-current": "step" }, "P"))).toContain('aria-current="step"');
        expect(html(createElement(NavLink, { href: "/admin/owners", "aria-current": "step" }, "P"))).toContain('aria-current="step"');
    });

    it("renders as a plain link with no router around it, where nothing is active", () => {
        expect(renderToString(createElement(NavLink, { href: "/admin/pets" }, "P"))).toBe('<a href="/admin/pets">P</a>');
    });
});
