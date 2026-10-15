export function whenDocumentReady(doc: Document, run: () => void): () => void {
  if (doc.readyState !== "loading") {
    run();
    return () => {};
  }
  const onReady = (): void => {
    doc.removeEventListener("DOMContentLoaded", onReady);
    run();
  };
  doc.addEventListener("DOMContentLoaded", onReady);
  return () => doc.removeEventListener("DOMContentLoaded", onReady);
}
