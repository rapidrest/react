// Fixture used to verify the hard-coded 500 fallback when the _500.tsx page itself fails to import.
export default function ThrowsPage(): never {
    throw new Error("boom - primary page throws");
}
