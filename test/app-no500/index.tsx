// Fixture used to verify the hard-coded 500 fallback when no _500.tsx page exists.
export default function ThrowsPage(): never {
    throw new Error("boom - no 500 page configured");
}
