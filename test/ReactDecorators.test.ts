///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import { ReactService } from "../src/ReactDecorators.js";

describe("ReactService", () => {
    it("Records a single string path as metadata.", () => {
        class Single {}
        ReactService("/app/single")(Single);
        expect(Reflect.getMetadata("rrst:reactServicePaths", Single.prototype)).toEqual(["/app/single"]);
    });

    it("Records an array of paths as metadata.", () => {
        class Multi {}
        ReactService(["/app/a", "/app/b"])(Multi);
        expect(Reflect.getMetadata("rrst:reactServicePaths", Multi.prototype)).toEqual(["/app/a", "/app/b"]);
    });

    it("Concatenates paths across repeated applications on the same target.", () => {
        class Stacked {}
        ReactService("/app/one")(Stacked);
        ReactService(["/app/two", "/app/three"])(Stacked);
        expect(Reflect.getMetadata("rrst:reactServicePaths", Stacked.prototype)).toEqual([
            "/app/one",
            "/app/two",
            "/app/three",
        ]);
    });
});
