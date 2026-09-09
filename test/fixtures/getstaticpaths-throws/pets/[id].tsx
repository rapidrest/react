export default function Pet() { return null; }

export async function getStaticPaths() {
    throw new Error("boom");
}
