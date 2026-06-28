///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { RouteDecorators } from "@rapidrest/service-core";
import { ComponentType, PropsWithChildren } from "react";
import React from "react";
import { ReactRoute } from "../../../src/ReactRoute.js";
import { Layout } from "../components/Layout.js";

const {
    Route,
} = RouteDecorators;

@Route("/app")
export class DefaultRoute extends ReactRoute {
    protected layout: ComponentType<PropsWithChildren> = Layout;
    protected renderHTML(props?: any) {
        return <>Hello World!</>;
    }
}
