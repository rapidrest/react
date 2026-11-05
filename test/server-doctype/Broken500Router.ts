///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { ReactRoute } from "../../src/ReactRoute.js";

const { Route } = RouteDecorators;
/** Serves an app whose `_500` page fails to import. */
@Route("/dt-broken500")
export class Broken500Router extends ReactRoute {
    protected readonly appDir: string = "test/app-broken500";
}
