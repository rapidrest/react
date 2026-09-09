///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";

interface Props {
    params?: { id?: string; reviewId?: string };
}

export default function PetReview({ params }: Props) {
    return <p>{`PetId:${params?.id} ReviewId:${params?.reviewId}`}</p>;
}
