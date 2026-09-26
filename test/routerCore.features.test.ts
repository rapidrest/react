///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { vi } from "vitest";
import {
    Blocker,
    ClientRoute,
    DEFAULT_BLOCK_MESSAGE,
    isInterceptableAnchor,
    mergeEffects,
    PagePayload,
    Router,
    RouterPlatform,
} from "../src/routerCore.js";

/*
 * The router core's later features — shallow navigation, the pending state, blockers, navigation effects, prefetching
 * without data — against a fake browser: a platform whose history is a real list of entries, so that going back and forward
 * (and being refused) is checked against what the browser would do, not against what the router asks of it.
 */

const ORIGIN = "https://example.com";
const page = (name: string) => ({ default: name });
const route = (template: string): ClientRoute => ({ template, load: vi.fn(async () => page(template)) });

interface Entry {
    url: URL;
    index: number | null;
    shallow: boolean;
}

/** A browser's session history and the platform over it, with a location that follows it. */
function fakeBrowser(start: string) {
    const entries: Entry[] = [{ url: new URL(ORIGIN + start), index: null, shallow: false }];
    let position = 0;
    /** Listeners for the `popstate` the browser would fire after a history traversal. */
    const traversed: Array<() => void> = [];
    const fetchPayload = vi.fn(async (url: URL): Promise<PagePayload | null> => {
        const item = /\/users\/(\w+)$/.exec(url.pathname);
        return item ? { route: "/users/:id", props: { id: item[1] }, css: ["/a.css"], title: `User ${item[1]}` } : { route: "/users", props: {}, css: [] };
    });
    const platform: RouterPlatform = {
        location: () => entries[position].url,
        fetchPayload: fetchPayload,
        ensureStyles: vi.fn(async () => undefined),
        pruneStyles: vi.fn(),
        setTitle: vi.fn(),
        render: vi.fn(),
        update: vi.fn(),
        setPending: vi.fn(),
        saveScroll: vi.fn(),
        commitHistory: vi.fn((url: URL, mode: "push" | "replace", shallow?: boolean) => {
            const here = entries[position].index ?? position;
            if (mode === "push") {
                if (entries[position].index === null) entries[position].index = here;
                entries.splice(position + 1);
                entries.push({ url, index: here + 1, shallow: shallow === true });
                position++;
            } else {
                entries[position] = { url, index: here, shallow: shallow === true };
            }
        }),
        historyEntry: vi.fn(() => ({ index: entries[position].index, shallow: entries[position].shallow })),
        historyGo: vi.fn((delta: number) => {
            position += delta;
            traversed.forEach((listener) => listener());
        }),
        settle: vi.fn(),
        announce: vi.fn(),
        confirm: vi.fn(() => true),
        hardNavigate: vi.fn(),
    };
    return {
        platform,
        fetchPayload,
        entries,
        /** What the user does with the back and forward buttons: the browser moves, then tells the page. */
        traverse: (delta: number) => {
            position += delta;
        },
        onTraversal: (listener: () => void) => traversed.push(listener),
        position: () => position,
    };
}

describe("Router", () => {
    let routes: ClientRoute[];

    beforeEach(() => {
        routes = [route("/"), route("/users"), route("/users/new"), route("/users/:id")];
    });

    const routerAt = (start: string, over: { route?: string; effects?: any } = {}) => {
        const browser = fakeBrowser(start);
        const router = new Router(routes, "/admin", browser.platform, () => 0, over);
        return { ...browser, router };
    };

    describe("the route on screen", () => {
        it("is worked out from the URL the router starts on, or told by the server", () => {
            const fromUrl = routerAt("/admin/users/7");
            expect((fromUrl.router as any).template).toBe("/users/:id");

            // The URL's spelling can differ from the route's: `/admin/index` is the page at `/`.
            const told = routerAt("/admin/index", { route: "/" });
            expect((told.router as any).template).toBe("/");

            const unknown = routerAt("/admin/nope/nope");
            expect((unknown.router as any).template).toBe("");
        });

        it("reports the URL the browser is at", () => {
            expect(routerAt("/admin/users/7?x=1").router.currentUrl().href).toBe(ORIGIN + "/admin/users/7?x=1");
        });
    });

    describe("shallow navigation", () => {
        it("keeps the page: no fetch, no new instance, only the location (and params) updated", async () => {
            const { router, platform, fetchPayload } = routerAt("/admin/users/7");

            expect(await router.navigate("/admin/users/8?tab=2", { shallow: true })).toBe(true);

            expect(fetchPayload).not.toHaveBeenCalled();
            expect(platform.render).not.toHaveBeenCalled();
            expect(platform.update).toHaveBeenCalledWith({ url: expect.objectContaining({ search: "?tab=2" }), params: { id: "8" } });
            expect(platform.commitHistory).toHaveBeenCalledWith(expect.anything(), "push", true);
            expect(platform.saveScroll).not.toHaveBeenCalled();
            // Nothing to scroll to, nothing to focus, nothing new to announce: it's the same page.
            expect(platform.settle).not.toHaveBeenCalled();
            expect(platform.announce).not.toHaveBeenCalled();
            expect(router.isPending()).toBe(false);
        });

        it("is what `remount: false` means too, and replaces the entry when asked to or when it's the URL already showing", async () => {
            const { router, platform } = routerAt("/admin/users/7");

            await router.navigate("/admin/users/7?a=1", { remount: false, replace: true });
            expect(platform.update).toHaveBeenCalledTimes(1);
            expect(platform.commitHistory).toHaveBeenLastCalledWith(expect.anything(), "replace", true);

            await router.navigate("/admin/users/7?a=1", { shallow: true });
            expect(platform.commitHistory).toHaveBeenLastCalledWith(expect.anything(), "replace", true);

            // `remount: true` isn't shallow.
            await router.navigate("/admin/users/9", { remount: true });
            expect(platform.render).toHaveBeenCalledTimes(1);
        });

        it("is an ordinary navigation when the destination is another route", async () => {
            const { router, platform, fetchPayload } = routerAt("/admin/users/7");

            await router.navigate("/admin/users", { shallow: true });

            expect(fetchPayload).toHaveBeenCalledTimes(1);
            expect(platform.render).toHaveBeenCalledTimes(1);
            expect(platform.update).not.toHaveBeenCalled();
        });

        it("doesn't ask a blocker, since the page and what's in it stay", async () => {
            const { router, platform } = routerAt("/admin/users/7");
            router.block({ active: () => true });

            expect(await router.navigate("/admin/users/8", { shallow: true })).toBe(true);

            expect(platform.confirm).not.toHaveBeenCalled();
        });

        it("becomes what the next navigation is measured against: the route on screen is the one it kept", async () => {
            const { router, platform } = routerAt("/admin/users/7");
            await router.navigate("/admin/users/8", { shallow: true });
            await router.navigate("/admin/users/9", { shallow: true });
            expect(platform.update).toHaveBeenCalledTimes(2);
            expect(platform.render).not.toHaveBeenCalled();
        });

        describe("with refetch", () => {
            it("fetches the page's props for the new URL and gives them to the page that stays, setting the title", async () => {
                const { router, platform, fetchPayload } = routerAt("/admin/users/7");

                expect(await router.navigate("/admin/users/8", { shallow: true, refetch: true })).toBe(true);

                expect(fetchPayload).toHaveBeenCalledTimes(1);
                expect(platform.update).toHaveBeenCalledWith({
                    url: expect.objectContaining({ pathname: "/admin/users/8" }),
                    params: { id: "8" },
                    props: { id: "8" },
                });
                expect(platform.setTitle).toHaveBeenCalledWith("User 8");
                expect(platform.render).not.toHaveBeenCalled();
                // In flight while it was fetched, and not after.
                expect(vi.mocked(platform.setPending).mock.calls).toEqual([[true], [false]]);
            });

            it("leaves the title alone when the server didn't send one", async () => {
                const { router, platform, fetchPayload } = routerAt("/admin/users/7");
                fetchPayload.mockResolvedValueOnce({ route: "/users/:id", props: { id: "8" }, css: [] });
                await router.navigate("/admin/users/8", { shallow: true, refetch: true });
                expect(platform.setTitle).not.toHaveBeenCalled();
            });

            it("has the browser load the page when the server says it's another route, or can't say", async () => {
                const { router, platform, fetchPayload } = routerAt("/admin/users/7");
                fetchPayload.mockResolvedValueOnce({ route: "/users", props: {}, css: [] });
                expect(await router.navigate("/admin/users/8", { shallow: true, refetch: true })).toBe(false);
                expect(platform.hardNavigate).toHaveBeenLastCalledWith(ORIGIN + "/admin/users/8");

                fetchPayload.mockResolvedValueOnce(null);
                expect(await router.navigate("/admin/users/9", { shallow: true, refetch: true })).toBe(false);
                fetchPayload.mockRejectedValueOnce(new TypeError("network down"));
                expect(await router.navigate("/admin/users/10", { shallow: true, refetch: true })).toBe(false);
                expect(platform.hardNavigate).toHaveBeenCalledTimes(3);
                expect(platform.update).not.toHaveBeenCalled();
                expect(router.isPending()).toBe(false);
            });

            it("drops a fetch that was overtaken, whether it finished or failed", async () => {
                const { router, platform, fetchPayload } = routerAt("/admin/users/7");
                let finish!: (payload: PagePayload) => void;
                let fail!: (error: Error) => void;
                fetchPayload.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
                fetchPayload.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));

                const first = router.navigate("/admin/users/8", { shallow: true, refetch: true });
                const second = router.navigate("/admin/users/9", { shallow: true, refetch: true });
                finish({ route: "/users/:id", props: { id: "8" }, css: [] });
                expect(await first).toBe(true);
                expect(platform.update).not.toHaveBeenCalled();
                // Still pending: the second is in flight.
                expect(router.isPending()).toBe(true);

                fail(new DOMException("aborted", "AbortError"));
                await second.then(() => undefined);
                const third = router.navigate("/admin/users/10", { shallow: true, refetch: true });
                const fourth = router.navigate("/admin/users/11", { shallow: true });
                expect(await fourth).toBe(true);
                expect(await third).toBe(true);
                expect(platform.hardNavigate).toHaveBeenCalledTimes(1);
            });

            it("doesn't take the failure of a fetch that was overtaken for a reason to load its page", async () => {
                const { router, platform, fetchPayload } = routerAt("/admin/users/7");
                let fail!: (error: Error) => void;
                fetchPayload.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));

                const first = router.navigate("/admin/users/8", { shallow: true, refetch: true });
                await router.navigate("/admin/users/9", { shallow: true });
                fail(new DOMException("aborted", "AbortError"));

                expect(await first).toBe(true);
                expect(platform.hardNavigate).not.toHaveBeenCalled();
            });

            it("takes over from a navigation still under way, aborting its request", async () => {
                const { router, platform, fetchPayload } = routerAt("/admin/users/7");
                let signal!: AbortSignal;
                fetchPayload.mockImplementationOnce((_url: URL, s: AbortSignal) => {
                    signal = s;
                    return new Promise(() => undefined);
                });
                void router.navigate("/admin/users", {});
                expect(router.isPending()).toBe(true);

                await router.navigate("/admin/users/8", { shallow: true });

                expect(signal.aborted).toBe(true);
                expect(router.isPending()).toBe(false);
                expect(platform.update).toHaveBeenCalledTimes(1);
            });
        });
    });

    describe("a #fragment", () => {
        it("updates what reads the location, without a new page instance", async () => {
            const { router, platform } = routerAt("/admin/users/7");

            await router.navigate("#one");

            expect(platform.update).toHaveBeenCalledWith({ url: expect.objectContaining({ hash: "#one" }) });
            expect(platform.render).not.toHaveBeenCalled();
        });

        it("is what going back to one does, too", async () => {
            const { router, platform, traverse } = routerAt("/admin/users/7");
            await router.navigate("#one");
            vi.mocked(platform.update).mockClear();

            traverse(-1);
            expect(await router.popstate()).toBe(true);

            expect(platform.update).toHaveBeenCalledWith({ url: expect.objectContaining({ hash: "" }) });
            expect(platform.render).not.toHaveBeenCalled();
            expect(platform.settle).toHaveBeenCalledTimes(1);
        });
    });

    describe("back and forward over shallow navigations", () => {
        it("keeps the page instance going back over one, and forward again", async () => {
            const { router, platform, fetchPayload, traverse } = routerAt("/admin/users/7");
            await router.navigate("/admin/users/7?a=1", { shallow: true });
            vi.mocked(platform.update).mockClear();

            traverse(-1);
            expect(await router.popstate()).toBe(true);
            expect(platform.update).toHaveBeenCalledWith({ url: expect.objectContaining({ search: "" }), params: { id: "7" } });

            traverse(1);
            expect(await router.popstate()).toBe(true);
            expect(platform.update).toHaveBeenLastCalledWith({ url: expect.objectContaining({ search: "?a=1" }), params: { id: "7" } });

            expect(fetchPayload).not.toHaveBeenCalled();
            expect(platform.render).not.toHaveBeenCalled();
            expect(platform.commitHistory).toHaveBeenCalledTimes(1);
        });

        it("is an ordinary navigation when the entry isn't one of the same route", async () => {
            const { router, platform, traverse } = routerAt("/admin/users/7");
            await router.navigate("/admin/users/8", { shallow: true });
            await router.navigate("/admin/users");
            expect(platform.render).toHaveBeenCalledTimes(1);

            // Back to the shallow entry from another route's page: its instance isn't there any more.
            traverse(-1);
            expect(await router.popstate()).toBe(true);

            expect(platform.render).toHaveBeenCalledTimes(2);
        });

        it("is an ordinary navigation over entries that weren't shallow", async () => {
            const { router, platform, traverse } = routerAt("/admin/users/7");
            await router.navigate("/admin/users/8");
            traverse(-1);
            await router.popstate();
            expect(platform.render).toHaveBeenCalledTimes(2);
        });
    });

    describe("pending", () => {
        it("is on while a navigation is in flight and off once its page is on screen, telling whoever's listening", async () => {
            const { router, platform, fetchPayload } = routerAt("/admin/users");
            let finish!: (payload: PagePayload) => void;
            fetchPayload.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
            const seen: boolean[] = [];
            const unsubscribe = router.subscribePending(() => seen.push(router.isPending()));
            expect(router.isPending()).toBe(false);

            const navigation = router.navigate("/admin/users/7");
            expect(router.isPending()).toBe(true);
            finish({ route: "/users/:id", props: { id: "7" }, css: [] });
            await navigation;

            expect(router.isPending()).toBe(false);
            expect(seen).toEqual([true, false]);
            // Off before the page renders, so that one render puts the page and the end of the wait on screen.
            const order = vi.mocked(platform.setPending).mock.invocationCallOrder;
            expect(order[1]).toBeLessThan(vi.mocked(platform.render).mock.invocationCallOrder[0]);

            unsubscribe();
            await router.navigate("/admin/users");
            expect(seen).toEqual([true, false]);
        });

        it("tells the platform only when it changes", async () => {
            const { router, platform } = routerAt("/admin/users");
            await router.navigate("/admin/users/7");
            expect(vi.mocked(platform.setPending).mock.calls).toEqual([[true], [false]]);
        });

        it("stays on for the newest navigation when an older one is overtaken, and ends with it", async () => {
            const { router, fetchPayload } = routerAt("/admin/users");
            let finishFirst!: (payload: PagePayload) => void;
            let finishSecond!: (payload: PagePayload) => void;
            fetchPayload.mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)));
            fetchPayload.mockImplementationOnce(() => new Promise((resolve) => (finishSecond = resolve)));

            const first = router.navigate("/admin/users/1");
            const second = router.navigate("/admin/users/2");
            finishFirst({ route: "/users/:id", props: { id: "1" }, css: [] });
            await first;
            expect(router.isPending()).toBe(true);
            finishSecond({ route: "/users/:id", props: { id: "2" }, css: [] });
            await second;
            expect(router.isPending()).toBe(false);
        });

        it("is off when the navigation was left to the browser", async () => {
            const { router, platform, fetchPayload } = routerAt("/admin/users");
            fetchPayload.mockResolvedValueOnce(null);
            await router.navigate("/admin/users/7");
            expect(platform.hardNavigate).toHaveBeenCalled();
            expect(router.isPending()).toBe(false);
        });
    });

    describe("announcing", () => {
        it("tells the platform once a page navigation has put its page on screen, and not for anything else", async () => {
            const { router, platform, traverse } = routerAt("/admin/users/7");
            await router.navigate("/admin/users");
            expect(platform.announce).toHaveBeenCalledTimes(1);
            expect(platform.announce).toHaveBeenCalledWith(expect.objectContaining({ pathname: "/admin/users" }));
            expect(vi.mocked(platform.announce).mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(platform.settle).mock.invocationCallOrder[0]);

            traverse(-1);
            await router.popstate();
            expect(platform.announce).toHaveBeenCalledTimes(2);

            await router.navigate("#frag");
            await router.navigate("/admin/users/7?x=1", { shallow: true });
            expect(platform.announce).toHaveBeenCalledTimes(2);
        });
    });

    describe("blockers", () => {
        const blocker = (over: Partial<Blocker> = {}): Blocker => ({ active: () => true, ...over });

        it("are asked, with the default message, before a navigation to another page, which is dropped if they refuse", async () => {
            const { router, platform, fetchPayload } = routerAt("/admin/users");
            router.block(blocker());
            vi.mocked(platform.confirm).mockReturnValue(false);

            expect(await router.navigate("/admin/users/7")).toBe(false);

            expect(platform.confirm).toHaveBeenCalledWith(DEFAULT_BLOCK_MESSAGE);
            expect(fetchPayload).not.toHaveBeenCalled();
            expect(platform.hardNavigate).not.toHaveBeenCalled();
            expect(platform.render).not.toHaveBeenCalled();
        });

        it("let the navigation go ahead when the user agrees, and are asked with their own message", async () => {
            const { router, platform } = routerAt("/admin/users");
            router.block(blocker({ message: "Discard?" }));

            expect(await router.navigate("/admin/users/7")).toBe(true);

            expect(platform.confirm).toHaveBeenCalledWith("Discard?");
            expect(platform.render).toHaveBeenCalledTimes(1);
        });

        it("can answer themselves, asynchronously, in place of the confirm dialog", async () => {
            const { router, platform } = routerAt("/admin/users");
            const onBlock = vi.fn(async () => false);
            router.block(blocker({ onBlock }));

            expect(await router.navigate("/admin/users/7")).toBe(false);
            expect(onBlock).toHaveBeenCalledWith({ to: ORIGIN + "/admin/users/7" });
            expect(platform.confirm).not.toHaveBeenCalled();

            onBlock.mockResolvedValue(true);
            expect(await router.navigate("/admin/users/7")).toBe(true);
        });

        it("block when their own answer throws: losing someone's work is worse than not letting them go", async () => {
            const { router, platform } = routerAt("/admin/users");
            router.block(
                blocker({
                    onBlock: () => {
                        throw new Error("dialog crashed");
                    },
                }),
            );
            expect(await router.navigate("/admin/users/7")).toBe(false);
            expect(platform.render).not.toHaveBeenCalled();
        });

        it("are skipped while they're not in force, and asked in turn, the first no ending it", async () => {
            const { router, platform } = routerAt("/admin/users");
            const asked: string[] = [];
            router.block(blocker({ active: () => false, message: "never" }));
            router.block(blocker({ message: "first", onBlock: () => (asked.push("first"), true) }));
            router.block(blocker({ message: "second", onBlock: () => (asked.push("second"), false) }));
            router.block(blocker({ message: "third", onBlock: () => (asked.push("third"), true) }));

            expect(await router.navigate("/admin/users/7")).toBe(false);

            expect(asked).toEqual(["first", "second"]);
            expect(platform.confirm).not.toHaveBeenCalled();
        });

        it("are removed by the function that registered them", async () => {
            const { router, platform } = routerAt("/admin/users");
            const remove = router.block(blocker());
            expect(router.shouldBlockUnload()).toBe(true);

            remove();

            expect(router.shouldBlockUnload()).toBe(false);
            expect(await router.navigate("/admin/users/7")).toBe(true);
            expect(platform.confirm).not.toHaveBeenCalled();
        });

        it("say whether a real page load has something to lose, only while they're in force", () => {
            const { router } = routerAt("/admin/users");
            let active = false;
            router.block(blocker({ active: () => active }));
            expect(router.shouldBlockUnload()).toBe(false);
            active = true;
            expect(router.shouldBlockUnload()).toBe(true);
        });

        it("aren't asked again while one question is still open: a second navigation is dropped, not stacked on it", async () => {
            const { router, platform } = routerAt("/admin/users");
            let answer!: (allowed: boolean) => void;
            router.block(blocker({ onBlock: () => new Promise<boolean>((resolve) => (answer = resolve)) }));

            const first = router.navigate("/admin/users/7");
            expect(await router.navigate("/admin/users/8")).toBe(false);
            answer(true);

            expect(await first).toBe(true);
            expect(platform.render).toHaveBeenCalledTimes(1);
            expect(platform.render).toHaveBeenCalledWith(expect.objectContaining({ props: { id: "7" } }));
        });

        it("aren't asked about a #fragment, or about leaving for a page the router can't show (the browser's own prompt does that)", async () => {
            const { router, platform } = routerAt("/admin/users");
            router.block(blocker());

            await router.navigate("#frag");
            expect(await router.navigate("/elsewhere")).toBe(false);

            expect(platform.confirm).not.toHaveBeenCalled();
            expect(platform.hardNavigate).toHaveBeenCalledWith(ORIGIN + "/elsewhere");
        });

        describe("and back or forward", () => {
            /** A router that's been through `/admin/users` → `/admin/users/7` → `/admin/users/8`, with a blocker. */
            async function blocked() {
                const env = routerAt("/admin/users");
                await env.router.navigate("/admin/users/7");
                await env.router.navigate("/admin/users/8");
                vi.mocked(env.platform.render).mockClear();
                env.router.block(blocker());
                return env;
            }

            it("ask before leaving, and let the user go when they agree", async () => {
                const { router, platform, traverse } = await blocked();

                traverse(-1);
                expect(await router.popstate()).toBe(true);

                expect(platform.confirm).toHaveBeenCalledTimes(1);
                expect(platform.render).toHaveBeenCalledWith(expect.objectContaining({ props: { id: "7" } }));
                expect(platform.historyGo).not.toHaveBeenCalled();
            });

            it("go back through history to the entry the user left when they refuse, and ignore the move that makes", async () => {
                const { router, platform, traverse, onTraversal, position } = await blocked();
                vi.mocked(platform.confirm).mockReturnValue(false);
                onTraversal(() => void router.popstate());

                traverse(-1);
                expect(await router.popstate()).toBe(false);

                // The browser was moved back one entry by the user, so it's moved forward one by the router.
                expect(platform.historyGo).toHaveBeenCalledWith(1);
                expect(position()).toBe(2);
                expect(platform.render).not.toHaveBeenCalled();
                expect(platform.commitHistory).toHaveBeenCalledTimes(2);
                // The `popstate` that move fired was the router's own doing, so it changed nothing: still on `/8`.
                await vi.waitFor(() => expect(platform.confirm).toHaveBeenCalledTimes(1));
                expect((router as any).restoring).toBe(false);
                expect(router.currentUrl().pathname).toBe("/admin/users/8");
            });

            it("go forward through history when it's forward that was refused", async () => {
                const { router, platform, traverse } = await blocked();
                traverse(-1);
                await router.popstate();
                vi.mocked(platform.historyGo).mockClear();
                vi.mocked(platform.confirm).mockReturnValue(false);

                traverse(1);
                expect(await router.popstate()).toBe(false);

                expect(platform.historyGo).toHaveBeenCalledWith(-1);
            });

            it("add an entry for the page still showing when where the entries are in history isn't known", async () => {
                const { router, platform, entries, traverse } = await blocked();
                vi.mocked(platform.confirm).mockReturnValue(false);
                // An entry from before the router was there has no position recorded.
                entries[1].index = null;

                traverse(-1);
                expect(await router.popstate()).toBe(false);

                expect(platform.historyGo).not.toHaveBeenCalled();
                expect(platform.commitHistory).toHaveBeenLastCalledWith(expect.objectContaining({ pathname: "/admin/users/8" }), "push");
            });

            it("mark that entry as shallow again when the page on screen came from a shallow navigation", async () => {
                const env = routerAt("/admin/users/7");
                await env.router.navigate("/admin/users/8", { shallow: true });
                env.router.block(blocker());
                vi.mocked(env.platform.confirm).mockReturnValue(false);
                env.entries[0].index = null;
                env.entries[1].index = null;
                // Back to a page of another route, which does ask.
                env.entries[0].url = new URL(ORIGIN + "/admin/users");
                env.traverse(-1);

                expect(await env.router.popstate()).toBe(false);

                expect(env.platform.commitHistory).toHaveBeenLastCalledWith(expect.objectContaining({ pathname: "/admin/users/8" }), "push", true);
            });

            it("forget an undo that never came back, so that the next real back or forward is heard", async () => {
                const { router, platform, traverse } = await blocked();
                vi.mocked(platform.confirm).mockReturnValue(false);
                traverse(-1);
                await router.popstate();
                expect((router as any).restoring).toBe(true);

                // No `popstate` for the undo (something else moved on): a navigation clears it.
                await router.navigate("/admin/users/9");
                expect((router as any).restoring).toBe(false);
            });

            it("put the page's URL back as an entry when the undo didn't land where the router recorded (a long session history is trimmed)", async () => {
                const { router, platform, traverse } = await blocked();
                vi.mocked(platform.confirm).mockReturnValue(false);
                traverse(-1);
                await router.popstate();
                vi.mocked(platform.commitHistory).mockClear();

                // The browser ended up somewhere else than the entry the router went for.
                traverse(-1);
                expect(await router.popstate()).toBe(true);

                expect(platform.commitHistory).toHaveBeenCalledWith(expect.objectContaining({ pathname: "/admin/users/8" }), "push");
                expect(platform.render).not.toHaveBeenCalled();
            });

            it("swallow the one popstate the undo causes", async () => {
                const { router, platform, traverse } = await blocked();
                vi.mocked(platform.confirm).mockReturnValue(false);
                traverse(-1);
                await router.popstate();
                vi.mocked(platform.confirm).mockClear();

                // The router's own `history.go(1)` arrives as a `popstate` too (the fake browser has already moved).
                expect(await router.popstate()).toBe(true);

                expect(platform.confirm).not.toHaveBeenCalled();
                expect(platform.render).not.toHaveBeenCalled();
            });
        });
    });

    describe("effects", () => {
        it("start as the app's, and are overridden by whatever is registered, the later slot winning, until it's removed", () => {
            const { router } = routerAt("/admin/users", { effects: { focus: "#app", scroll: "top" } });
            expect(router.effects()).toEqual({ focus: "#app", scroll: "top" });

            const removePage = router.addEffects({ slot: 2, get: () => ({ focus: "#page" }) });
            const removeShell = router.addEffects({ slot: 1, get: () => ({ focus: "#shell", scroll: "preserve" }) });
            expect(router.effects()).toEqual({ focus: "#page", scroll: "preserve" });

            removePage();
            expect(router.effects()).toEqual({ focus: "#shell", scroll: "preserve" });
            removePage();
            removeShell();
            expect(router.effects()).toEqual({ focus: "#app", scroll: "top" });
        });

        it("are read when they're wanted, not when they were registered", () => {
            const { router } = routerAt("/admin/users");
            let text = "one";
            router.addEffects({ slot: 1, get: () => ({ announce: () => text }) });
            expect((router.effects().announce as any)({ title: "", pathname: "" })).toBe("one");
            text = "two";
            expect((router.effects().announce as any)({ title: "", pathname: "" })).toBe("two");
        });

        it("are none at all by default", () => {
            expect(routerAt("/admin/users").router.effects()).toEqual({});
        });
    });

    describe("prefetch without data", () => {
        it("warms only the page's module, not its data, and only once", () => {
            const { router, fetchPayload } = routerAt("/admin/users");

            router.prefetch("/admin/users/7", { data: false });
            router.prefetch("/admin/users/8", { data: false });

            expect(fetchPayload).not.toHaveBeenCalled();
            expect(routes[3].load).toHaveBeenCalledTimes(1);
        });

        it("tries again when the module couldn't be loaded", async () => {
            const { router } = routerAt("/admin/users");
            (routes[3].load as any).mockRejectedValueOnce(new Error("chunk 404"));

            router.prefetch("/admin/users/7", { data: false });
            await new Promise((resolve) => setTimeout(resolve, 0));
            router.prefetch("/admin/users/7", { data: false });

            expect(routes[3].load).toHaveBeenCalledTimes(2);
        });

        it("follows the same safety rules: never a route only a root-level [slug] matches, nor anything not the app's", () => {
            routes = [route("/"), route("/:slug"), route("/users")];
            const { router, fetchPayload } = routerAt("/admin/users");

            router.prefetch("/admin/logout", { data: false });
            router.prefetch("https://other.example/admin/users", { data: false });
            router.prefetch("/elsewhere", { data: false });

            expect(routes[1].load).not.toHaveBeenCalled();
            expect(fetchPayload).not.toHaveBeenCalled();
        });

        it("still fetches the data by default, or with data: true", () => {
            const { router, fetchPayload } = routerAt("/admin/users");
            router.prefetch("/admin/users/7", { data: true });
            router.prefetch("/admin/users/8");
            expect(fetchPayload).toHaveBeenCalledTimes(2);
        });
    });
});

describe("mergeEffects", () => {
    it("lets each later source win for the settings it makes, and skips the ones it leaves out", () => {
        expect(mergeEffects({ focus: "#a", scroll: "top" }, { focus: undefined, scroll: false }, { focus: "#c" })).toEqual({
            focus: "#c",
            scroll: false,
        });
        expect(mergeEffects()).toEqual({});
    });

    it("keeps a `false`, which is a setting", () => {
        expect(mergeEffects({ focus: "#a" }, { focus: false })).toEqual({ focus: false });
    });
});

describe("isInterceptableAnchor", () => {
    const anchor = (attrs: Record<string, string>) => ({
        getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
        hasAttribute: (name: string) => name in attrs,
    });

    it("is true for a link with a destination the browser would open in the page", () => {
        expect(isInterceptableAnchor(anchor({ href: "/x" }))).toBe(true);
        expect(isInterceptableAnchor(anchor({ href: "/x", target: "_self", rel: "nofollow noopener" }))).toBe(true);
    });

    it("is false for one with no destination, that opens elsewhere, downloads, leaves the site, or opted out", () => {
        expect(isInterceptableAnchor(anchor({}))).toBe(false);
        expect(isInterceptableAnchor(anchor({ href: "/x", target: "_blank" }))).toBe(false);
        expect(isInterceptableAnchor(anchor({ href: "/x", download: "" }))).toBe(false);
        expect(isInterceptableAnchor(anchor({ href: "/x", "data-router-ignore": "" }))).toBe(false);
        expect(isInterceptableAnchor(anchor({ href: "/x", rel: "external" }))).toBe(false);
    });
});
