///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { ReactRoute } from "../../src/ReactRoute.js";

const { Route } = RouteDecorators;
/** Serves the always-failing app, which has its own `_500` page. */
@Route("/dt-throws")
export class ThrowsRouter extends ReactRoute {
    protected readonly appDir: string = "test/app-throws";
}
