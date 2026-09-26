///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { ReactRoute } from "../../src/ReactRoute.js";

const { Route } = RouteDecorators;
/** Serves `test/app-throws`, whose only page always throws. */
@Route("/throws-app")
export class ThrowsRouter extends ReactRoute {
    protected readonly appDir: string = "test/app-throws";
}
