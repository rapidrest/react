// Fixture with a working _500.tsx but no _layout.tsx, to exercise the unwrapped-error-page
// render path (no Layout available).
export default function ThrowsPage(): never {
    throw new Error("boom - no layout configured");
}
