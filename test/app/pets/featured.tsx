///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";

// A literal sibling of pets/[id].tsx — proves static routes win over a dynamic
// segment at the same directory level for a matching request (/pets/featured).
export default function FeaturedPet() {
    return <p>FeaturedPet</p>;
}
