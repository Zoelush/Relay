/** Bind as a private service; no public route. Only the attachment scanner calls this after approval. */
const previewWorker = {
  async fetch(request: Request, env: { IMAGES: ImagesBinding }) {
    if (request.method !== "POST" || !request.body)
      return new Response("Method not allowed", { status: 405 });
    if (
      !["image/png", "image/jpeg"].includes(
        request.headers.get("content-type") ?? "",
      )
    )
      return new Response("Unsupported image", { status: 415 });
    try {
      return (
        await env.IMAGES.input(request.body)
          .transform({ width: 1024, height: 1024, fit: "scale-down" })
          .output({ format: "image/png", anim: false })
      ).response();
    } catch {
      return new Response("Invalid image", { status: 422 });
    }
  },
};
export default previewWorker;
