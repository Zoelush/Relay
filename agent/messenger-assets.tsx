import { useState } from "react";
import { api } from "./api";
import { FAILURES, FileButton, waitForJob } from "./knowledge-files";

/**
 * Uploading the messenger's images (messenger settings M5; docs/MESSENGER_SETTINGS_STEP5.md): the
 * Home screen logo, the launcher logo and Home's background. An upload is prepared, put straight
 * into storage, then checked and scanned by a background job; the config then refers to it as
 * "asset:<id>". The server checks every size and type again.
 */
export type AssetPurpose = "home_logo" | "launcher_logo" | "home_background";
const ACCEPT = "image/png,image/jpeg,image/gif";
const MAX = 1024 * 1024;
const REF = /^asset:([0-9a-f-]{36})$/;

/** Where Settings shows an image: an upload through the agent app, or its https address. */
export function imageSource(value: string, origin = "") {
  const id = REF.exec(value)?.[1];
  if (id)
    return `${origin}/api/agent/messenger-asset?${new URLSearchParams({ id })}`;
  return /^https:\/\//.test(value) ? value : "";
}

/** Checks before any bytes move; null when the image can be uploaded. */
export function imageProblem(file: File) {
  if (file.type === "image/svg+xml" || /\.svg$/i.test(file.name))
    return "SVG images can carry scripts, so they aren't accepted. Save it as a PNG.";
  if (!ACCEPT.split(",").includes(file.type))
    return "Choose a PNG, JPG or GIF image.";
  if (file.size < 1 || file.size > MAX) return "Images can be up to 1 MB.";
  return null;
}

async function upload(
  file: File,
  brandId: string,
  purpose: AssetPurpose,
  progress: (state: string) => void,
) {
  const problem = imageProblem(file);
  if (problem) throw new Error(problem);
  progress("Uploading…");
  const prepared = await api<{
    assetId: string;
    url: string;
    headers: Record<string, string>;
  }>("messenger-assets", {
    op: "prepare",
    brandId,
    purpose,
    name: file.name.slice(0, 200) || "image",
    size: file.size,
    type: file.type,
  });
  const put = await fetch(prepared.url, {
    method: "PUT",
    headers: prepared.headers,
    body: file,
  });
  if (!put.ok) throw new Error("The image could not be uploaded. Try again.");
  const { jobId } = await api<{ jobId: string }>("messenger-assets", {
    op: "complete",
    assetId: prepared.assetId,
  });
  progress("Checking…");
  const result = await waitForJob(jobId);
  if (result.status !== "ready")
    throw new Error(
      FAILURES[result.reason ?? ""] ?? "The image could not be checked.",
    );
  return "asset:" + prepared.assetId;
}

/** An image the brand uploads: shown, changed or removed. The draft holds its reference. */
export function ImageField({
  label,
  hint,
  brandId,
  purpose,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  brandId: string;
  purpose: AssetPurpose;
  value: string;
  onChange: (value: string) => void;
}) {
  const [state, setState] = useState("");
  const [problem, setProblem] = useState("");
  const src = imageSource(value);
  const address = /^https:\/\//.test(value);
  return (
    <div
      className="pg-settings-field pg-messenger-image"
      role="group"
      aria-label={label}
    >
      <span className="pg-settings-label">{label}</span>
      <div className="pg-settings-row">
        <span className="pg-messenger-image-box">
          {src ? (
            // Authenticated file proxy: next/image would fetch without the session.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt={`${label} preview`} />
          ) : (
            <span className="pg-muted">None</span>
          )}
        </span>
        <FileButton
          label={value ? "Change" : "Upload"}
          inputLabel={`Upload the ${label.toLowerCase()}`}
          accept={ACCEPT}
          disabled={!!state}
          onFile={(chosen) => {
            setProblem("");
            void upload(chosen, brandId, purpose, setState)
              .then(onChange)
              .catch((err) =>
                setProblem(
                  err instanceof Error ? err.message : "That did not work.",
                ),
              )
              .finally(() => setState(""));
          }}
        />
        {value && (
          <button
            type="button"
            aria-label={`Remove the ${label.toLowerCase()}`}
            onClick={() => onChange("")}
          >
            Remove
          </button>
        )}
        {state && <span role="status">{state}</span>}
      </div>
      {address && (
        <small className="pg-muted">
          From an image address ({value}). Upload a file to replace it.
        </small>
      )}
      <small className="pg-muted">{hint}</small>
      {problem && (
        <span role="alert" className="pg-attr-error">
          {problem}
        </span>
      )}
    </div>
  );
}
