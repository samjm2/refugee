// Loads the bundled demo I-94 (public/examples/sample-i-94.pdf) as a File so the
// "Use an example I-94 (for judges)" buttons can feed it straight into the same
// extraction pipeline a real upload uses. Faithful to the public CBP I-94 sample
// (LYDIA LI). To use a different example, replace the file at that path.

export const EXAMPLE_I94_URL = "/examples/sample-i-94.pdf";
export const EXAMPLE_I94_FILENAME = "example-i-94.pdf";

export async function loadExampleI94File(): Promise<File> {
  const res = await fetch(EXAMPLE_I94_URL);
  if (!res.ok) throw new Error("Could not load the example I-94.");
  const blob = await res.blob();
  return new File([blob], EXAMPLE_I94_FILENAME, {
    type: blob.type || "application/pdf",
  });
}
