///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { ReactRoute } from "../../src/ReactRoute.js";

const { Route } = RouteDecorators;
/** Serves an app with neither a `_404` nor a `_500` page, so both hard-coded fallbacks are used. */
@Route("/dt-no500")
export class No500Router extends ReactRoute {
    protected readonly appDir: string = "test/app-no500";
}
