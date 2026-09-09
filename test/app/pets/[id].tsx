///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { HttpRequest } from "@rapidrest/service-core";

interface Props {
    params?: { id?: string };
    fromPage?: boolean;
    fromService?: boolean;
    serviceSawId?: string;
}

export default function PetDetail({ params, fromPage, fromService, serviceSawId }: Props) {
    return (
        <div>
            <p>{`PetId:${params?.id}`}</p>
            <p>{`FromPage:${fromPage}`}</p>
            <p>{`FromService:${fromService}`}</p>
            <p>{`ServiceSawId:${serviceSawId}`}</p>
        </div>
    );
}

// Merges alongside `params` (never clobbered by it) and alongside any @ReactService props.
export async function fetchProps(_req: HttpRequest) {
    return { fromPage: true };
}
