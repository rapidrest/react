///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { HttpRequest, RouteDecorators } from "@rapidrest/service-core";
import { ReactRoute } from "../../src/ReactRoute.js";

const { Route } = RouteDecorators;

// Use /app/* so it takes priority over the static-files /* handler (uWS.js gives
// more-specific prefix patterns priority over /* regardless of registration order).
@Route("/app/*")
export class AppRouter extends ReactRoute {
    protected readonly appDir: string = "test/app";

    protected override async fetchProps(req: HttpRequest): Promise<any> {
        // Return empty object for all other pages so their own fetchProps win.
        return {};
    }
}
