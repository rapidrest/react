///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { HttpRequest, RouteDecorators } from "@rapidrest/service-core";
import { ObjectDecorators } from "@rapidrest/core";
import { ReactRoute } from "../../src/ReactRoute.js";
import { PetService } from "./services/PetService.js";

const { Route } = RouteDecorators;
const { Inject } = ObjectDecorators;

// Use /app/* so it takes priority over the static-files /* handler (uWS.js gives
// more-specific prefix patterns priority over /* regardless of registration order).
@Route("/app/*")
export class AppRouter extends ReactRoute {
    // DI example: inject a service to provide data for the /di-pets page.
    // RapidREST's classLoader auto-discovers PetService from the server directory
    // and registers it in the objectFactory, making it available for injection.
    @Inject(PetService)
    private petService: PetService;

    protected override async fetchProps(req: HttpRequest): Promise<any> {
        if (req.path.endsWith("/di-pets")) {
            // Override with DB-sourced data — this takes precedence over any
            // fetchProps exported from the page file.
            return { pets: await this.petService.findAll() };
        }
        // Return empty object for all other pages so their own fetchProps win.
        return {};
    }
}
