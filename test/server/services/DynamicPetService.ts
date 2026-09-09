///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { HttpRequest } from "@rapidrest/service-core";
import { ReactService } from "../../../src/ReactDecorators";

/**
 * Example dynamic-path service: matched via a `:name` template against the request's page
 * segment, not an exact string lookup. `req.params` here comes from the page resolver's own
 * capture (ReactRoute.renderPage()), not from this template — the service's own captured value is
 * discarded and only used for instance selection.
 */
@ReactService("/app/pets/:id")
export class DynamicPetService {
    public async fetchProps(req: HttpRequest): Promise<any> {
        return { fromService: true, serviceSawId: req.params.id };
    }
}
