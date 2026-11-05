///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { ReactRoute } from "../../src/ReactRoute.js";

const { Route } = RouteDecorators;
/**
 * Serves `test/app` with a document that already starts with a doctype (in the unusual casing and spacing a hand-written
 * one might have): React can't render one, so it is written by a hook that runs on the finished document, the way a
 * Layout's output could arrive with one.
 */
@Route("/dt-own")
export class OwnDoctypeRouter extends ReactRoute {
    protected readonly appDir: string = "test/app";

    constructor() {
        super();
        (this as any).injectDevReloadScript = (html: string) => "\n<!doctype HTML>" + html;
    }
}
