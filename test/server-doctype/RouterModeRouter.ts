///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { ReactRoute } from "../../src/ReactRoute.js";

const { Route } = RouteDecorators;
/** Serves the router fixture app in router mode (full documents and client-navigation JSON). */
@Route("/dt-router")
export class RouterModeRouter extends ReactRoute {
    protected readonly appDir: string = "test/fixtures/router-app";
    protected readonly router: boolean = true;
}
