///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { isSafePathArg } from "../src/cli/validate.js";

describe("cli isSafePathArg", () => {
    it("Accepts normal relative/absolute paths, including ones with spaces.", () => {
        expect(isSafePathArg("src/server.ts")).toBe(true);
        expect(isSafePathArg("C:\\Program Files\\proj\\src\\server.ts")).toBe(true);
    });

    it("Rejects shell metacharacters.", () => {
        const bad = [
            "src/server.ts; rm -rf /",
            "src/server.ts && calc.exe",
            "$(whoami)",
            "`whoami`",
            "src/server.ts | tee out",
            'a"b',
        ];
        for (const value of bad) {
            expect(isSafePathArg(value)).toBe(false);
        }
    });

    it("Rejects an empty string.", () => {
        expect(isSafePathArg("")).toBe(false);
    });
});
