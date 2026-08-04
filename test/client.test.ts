///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
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

    describe("getHydrationProps", () => {
        it("Returns undefined when there is no document (server/non-DOM environment).", () => {
            expect(getHydrationProps()).toBeUndefined();
        });

        it("Returns undefined when the props element is not found in the DOM.", () => {
            (globalThis as any).document = { getElementById: vi.fn().mockReturnValue(null) };
            expect(getHydrationProps()).toBeUndefined();
            expect((globalThis as any).document.getElementById).toHaveBeenCalledWith("react-props");
        });

        it("Parses and returns the serialized props when found.", () => {
            (globalThis as any).document = {
                getElementById: vi.fn().mockReturnValue({ textContent: JSON.stringify({ a: 1 }) }),
            };
            expect(getHydrationProps()).toEqual({ a: 1 });
        });

        it("Uses the given propsId to look up the element.", () => {
            const getElementById = vi.fn().mockReturnValue({ textContent: "{}" });
            (globalThis as any).document = { getElementById };
            getHydrationProps("custom-id");
            expect(getElementById).toHaveBeenCalledWith("custom-id");
        });

        it("Returns undefined when the serialized content is not valid JSON.", () => {
            (globalThis as any).document = {
                getElementById: vi.fn().mockReturnValue({ textContent: "not-json{" }),
            };
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
            (globalThis as any).document = { getElementById: vi.fn().mockReturnValue(null) };
            hydrateRoute(FakePage);
            expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("react-root"));
            expect(hydrateRoot).not.toHaveBeenCalled();
            errSpy.mockRestore();
        });

        it("Hydrates the root with the component and serialized props when found.", () => {
            const container = { id: "react-root" };
            const getElementById = vi.fn((id: string) => (id === "react-root" ? container : { textContent: JSON.stringify({ x: 1 }) }));
            (globalThis as any).document = { getElementById };
            hydrateRoute(FakePage);
            expect(hydrateRoot).toHaveBeenCalledTimes(1);
            const [passedContainer, element] = vi.mocked(hydrateRoot).mock.calls[0];
            expect(passedContainer).toBe(container);
            expect(React.isValidElement(element)).toBe(true);
            expect((element as any).props).toEqual({ x: 1 });
        });

        it("Uses the given rootId and propsId.", () => {
            const container = { id: "custom-root" };
            const getElementById = vi.fn((id: string) =>
                id === "custom-root" ? container : id === "custom-props" ? { textContent: "{}" } : null,
            );
            (globalThis as any).document = { getElementById };
            hydrateRoute(FakePage, "custom-root", "custom-props");
            expect(getElementById).toHaveBeenCalledWith("custom-root");
            expect(getElementById).toHaveBeenCalledWith("custom-props");
            expect(hydrateRoot).toHaveBeenCalledTimes(1);
        });
    });
});
