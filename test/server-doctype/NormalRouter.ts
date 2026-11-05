///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { ReactRoute } from "../../src/ReactRoute.js";

const { Route } = RouteDecorators;
/** Serves `test/app`: a layout and a `_404` page. */
@Route("/dt-normal")
export class NormalRouter extends ReactRoute {
    protected readonly appDir: string = "test/app";
}
