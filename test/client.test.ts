///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { vi } from "vitest";
import { hydrateRoot } from "react-dom/client";
import { getHydrationProps, hydrateRoute } from "../src/client.js";

vi.mock("react-dom/client", () => ({ hydrateRoot: vi.fn() }));

function FakePage(_props: any) {
    return null;
}

describe("client", () => {
    afterEach(() => {
        delete (globalThis as any).document;
    });

    /** A document whose JSON scripts are `scripts`, and whose other elements (by id) are `elements`. */
    const documentWith = (scripts: Array<{ id: string; textContent: string }>, elements: Record<string, any> = {}) => ({
        querySelectorAll: vi.fn(() => scripts),
        getElementById: vi.fn((id: string) => elements[id] ?? null),
    });

    describe("getHydrationProps", () => {
        it("Returns undefined when there is no document (server/non-DOM environment).", () => {
            expect(getHydrationProps()).toBeUndefined();
        });

        it("Returns undefined when the props element is not found in the DOM.", () => {
            (globalThis as any).document = documentWith([]);
            expect(getHydrationProps()).toBeUndefined();
            expect((globalThis as any).document.querySelectorAll).toHaveBeenCalledWith('script[type="application/json"]');
        });

        it("Parses and returns the serialized props when found.", () => {
            (globalThis as any).document = documentWith([{ id: "react-props", textContent: JSON.stringify({ a: 1 }) }]);
            expect(getHydrationProps()).toEqual({ a: 1 });
        });

        it("Uses the given propsId to look up the element.", () => {
            (globalThis as any).document = documentWith([
                { id: "react-props", textContent: '{"wrong":true}' },
                { id: "custom-id", textContent: '{"right":true}' },
            ]);
            expect(getHydrationProps("custom-id")).toEqual({ right: true });
        });

        it("Only reads a JSON script: an element of that id that page content put earlier in the document is not one.", () => {
            // (The selector is what excludes it: `document.getElementById("react-props")` would have answered with it.)
            const document = documentWith([{ id: "react-props", textContent: '{"ours":true}' }], {
                "react-props": { textContent: '{"attacker":true}' },
            });
            (globalThis as any).document = document;
            expect(getHydrationProps()).toEqual({ ours: true });
            expect(document.getElementById).not.toHaveBeenCalled();
        });

        it("Returns undefined when the serialized content is not valid JSON.", () => {
            (globalThis as any).document = documentWith([{ id: "react-props", textContent: "not-json{" }]);
            expect(getHydrationProps()).toBeUndefined();
        });
    });

    describe("hydrateRoute", () => {
        it("Does nothing when there is no document (server/non-DOM environment).", () => {
            hydrateRoute(FakePage);
            expect(hydrateRoot).not.toHaveBeenCalled();
        });

        it("Logs an error and does not hydrate when the root element is missing.", () => {
            const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
            (globalThis as any).document = documentWith([]);
            hydrateRoute(FakePage);
            expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("react-root"));
            expect(hydrateRoot).not.toHaveBeenCalled();
            errSpy.mockRestore();
        });

        it("Hydrates the root with the component and serialized props when found.", () => {
            const container = { id: "react-root" };
            (globalThis as any).document = documentWith([{ id: "react-props", textContent: JSON.stringify({ x: 1 }) }], {
                "react-root": container,
            });
            hydrateRoute(FakePage);
            expect(hydrateRoot).toHaveBeenCalledTimes(1);
            const [passedContainer, element] = vi.mocked(hydrateRoot).mock.calls[0];
            expect(passedContainer).toBe(container);
            expect(React.isValidElement(element)).toBe(true);
            expect((element as any).props).toEqual({ x: 1 });
        });

        it("Uses the given rootId and propsId.", () => {
            const container = { id: "custom-root" };
            const document = documentWith([{ id: "custom-props", textContent: '{"p":1}' }], { "custom-root": container });
            (globalThis as any).document = document;
            hydrateRoute(FakePage, "custom-root", "custom-props");
            expect(document.getElementById).toHaveBeenCalledWith("custom-root");
            expect(vi.mocked(hydrateRoot).mock.calls[0][0]).toBe(container);
            expect((vi.mocked(hydrateRoot).mock.calls[0][1] as any).props).toEqual({ p: 1 });
        });
    });
});
