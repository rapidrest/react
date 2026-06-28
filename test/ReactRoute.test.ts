///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import config from "./config";
import { request } from "@rapidrest/service-core/dist/lib/test/request.js";
import { Server, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";

describe("ReactRoute Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server(config, "./test/server", logger, objectFactory);
    const baseUrl = "/app";

    beforeAll(async () => {
        await server.start();
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    it("Can serve pre-rendered React content.", async () => {
        expect(server.isRunning()).toBe(true);
        const result = await request(server.getApplication()).get(baseUrl);
        expect(result).toBeDefined();
        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body).toBeDefined();
        expect(result.body).toBe("<html><head></head><body>Hello World!</body></html>");
    });
});
