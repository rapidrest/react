///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import React from "react";

interface Props {
    pets?: string[];
}

// No fetchProps export — data is provided entirely by the DI override in AppRouter.
export default function DiPetsPage({ pets = [] }: Props) {
    return (
        <ul>
            {pets.map((pet) => <li key={pet}>{pet}</li>)}
        </ul>
    );
}
