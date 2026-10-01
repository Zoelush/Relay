import { useEffect, useRef, useState } from "react";
import { api } from "./api";

/**
 * Knowledge files in the agent app (phase 07, step C1a): uploading documents as file records,
 * images for articles and help center themes, and a file record's status panel.
 *
 * An upload is prepared, put straight into storage, then scanned (and, for a document, read) by a
 * background job; the browser waits on that job. The server checks every size and type again.
 */
const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCUMENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: DOCX,
  html: "text/html",
  htm: "text/html",
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
};
export const DOCUMENT_ACCEPT = Object.keys(DOCUMENT_TYPES)
  .map((e) => "." + e)
  .join(",");
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";
const MAX_DOCUMENT = 20 * 1024 * 1024,
  MAX_IMAGE = 5 * 1024 * 1024;

/** Why a file was refused or could not be read, in words a teammate can act on. */
export const FAILURES: Record<string, string> = {
  VIRUS_DETECTED: "The virus scanner blocked this file.",
  TYPE_MISMATCH:
    "The file's contents do not match its type. Save it again in the format its name says.",
  SIZE_MISMATCH: "The upload did not arrive complete. Try again.",
  PDF_ENCRYPTED:
    "This PDF is password-protected. Remove the password, then upload it again.",
  NO_TEXT:
    "No text was found in this file. If it is a scan, run text recognition (OCR) on it first.",
  UNREADABLE: "This file is damaged or could not be read.",
};
const STATUS_WORDS: Record<string, string> = {
  uploading: "Uploading…",
  scanning: "Checking and reading…",
  ready: "Ready",
  rejected: "Blocked",
  failed: "Could not be read",
  replaced: "Replaced",
  removed: "Removed",
};

/** The document type to declare for a file (browsers often leave Markdown untyped). */
export function documentType(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return DOCUMENT_TYPES[extension] ?? "";
}
/** Checks before any bytes move; null when the file can be uploaded. */
export function fileProblem(file: File, image: boolean) {
  if (image) {
    if (!IMAGE_ACCEPT.split(",").includes(file.type))
      return "Choose a PNG, JPEG, GIF or WebP image.";
    if (file.size < 1 || file.size > MAX_IMAGE)
      return "Images can be up to 5 MB.";
  } else {
    if (!documentType(file))
      return "Choose a PDF, Word (.docx), HTML, Markdown or text file.";
    if (file.size < 1 || file.size > MAX_DOCUMENT)
      return "Files can be up to 20 MB.";
  }
  return null;
}

type Target =
  | { purpose: "source"; recordId?: string; locale?: string }
  | { purpose: "article_image"; recordId: string }
  | {
      purpose: "theme_logo" | "theme_favicon" | "social_image";
      centerId: string;
    };

/** Uploads a file and waits for its check: resolves when it is ready, rejects with the reason. */
export async function uploadKnowledgeFile(
  file: File,
  target: Target,
  progress: (state: "uploading" | "scanning") => void = () => {},
) {
  const image = target.purpose !== "source";
  const problem = fileProblem(file, image);
  if (problem) throw new Error(problem);
  progress("uploading");
  const prepared = await api<{
    fileId: string;
    recordId: string | null;
    url: string;
    headers: Record<string, string>;
  }>("knowledge-files", {
    op: "prepare",
    ...target,
    name: file.name.slice(0, 200) || "file",
    size: file.size,
    type: image ? file.type : documentType(file),
  });
  const put = await fetch(prepared.url, {
    method: "PUT",
    headers: prepared.headers,
    body: file,
  });
  if (!put.ok) throw new Error("The file could not be uploaded. Try again.");
  const { jobId } = await api<{ jobId: string }>("knowledge-files", {
    op: "complete",
    fileId: prepared.fileId,
  });
  progress("scanning");
  const result = await waitForJob(jobId);
  if (result.status !== "ready" && result.status !== "replaced")
    throw Object.assign(
      new Error(
        FAILURES[result.reason ?? ""] ?? "The file could not be processed.",
      ),
      { fileId: prepared.fileId, recordId: prepared.recordId },
    );
  return { fileId: prepared.fileId, recordId: prepared.recordId };
}
/** Polls the job until it finishes (up to about five minutes for a long document). */
async function waitForJob(jobId: string) {
  for (let i = 0; i < 200; i++) {
    const job = await api<{
      state: string;
      result?: { status?: string; reason?: string };
    }>("job?" + new URLSearchParams({ id: jobId }));
    if (job.state === "succeeded")
      return { status: job.result?.status ?? "", reason: job.result?.reason };
    if (job.state === "dead_letter")
      return { status: "failed", reason: "UNREADABLE" };
    await new Promise((r) => setTimeout(r, i < 10 ? 700 : 1500));
  }
  throw new Error(
    "This is taking a long time. Its status will update when you reopen it.",
  );
}

export type FileSummary = {
  id: string;
  name: string;
  size: number;
  type: string;
  version: number;
  status: string;
  failure: string | null;
  pages: number | null;
  chars: number | null;
  truncated: boolean;
  liveVersion: number | null;
  readyAt: string | null;
  excerpt: string | null;
};
const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** A file record's file: its state, what was read from it, replace, download and remove. */
export function FilePanel({
  recordId,
  file,
  canManage,
  onChanged,
}: {
  recordId: string;
  file: FileSummary | null;
  canManage: boolean;
  onChanged: (notice: string) => Promise<void> | void;
}) {
  const [busy, setBusy] = useState("");
  const [problem, setProblem] = useState("");
  // A file still being checked (opened from another tab, say) is refreshed until it settles,
  // for up to two minutes; after that, reopening it shows the latest state.
  const pending = file?.status === "scanning";
  const polls = useRef({ id: "", count: 0 });
  useEffect(() => {
    if (!pending || busy || !file) return;
    if (polls.current.id !== file.id) polls.current = { id: file.id, count: 0 };
    if (++polls.current.count > 60) return;
    const timer = setTimeout(() => void onChanged(""), 2000);
    return () => clearTimeout(timer);
  }, [pending, busy, onChanged, file]);
  async function replace(chosen: File) {
    setProblem("");
    try {
      await uploadKnowledgeFile(chosen, { purpose: "source", recordId }, (s) =>
        setBusy(STATUS_WORDS[s]),
      );
      await onChanged("The new version is live.");
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "That did not work.");
      await onChanged("");
    } finally {
      setBusy("");
    }
  }
  async function remove() {
    if (
      !window.confirm("Remove this file? It leaves search and every surface.")
    )
      return;
    try {
      await api("knowledge-files", { op: "remove", recordId });
      await onChanged("Removed.");
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "That did not work.");
    }
  }
  const failure = file?.failure ? FAILURES[file.failure] : "";
  return (
    <section className="pg-knowledge-file" aria-label="File">
      <h3>File</h3>
      {file ? (
        <>
          <p>
            <strong>{file.name}</strong>{" "}
            <span className="pg-muted">
              {size(file.size)} · version {file.version}
            </span>
          </p>
          <p
            role="status"
            className={
              file.status === "rejected" || file.status === "failed"
                ? "pg-knowledge-warn"
                : undefined
            }
          >
            {busy || STATUS_WORDS[file.status] || file.status}
            {failure ? `: ${failure}` : ""}
          </p>
          {file.liveVersion !== null && file.liveVersion !== file.version && (
            <p className="pg-muted">
              Version {file.liveVersion} stays live until a new version is read.
            </p>
          )}
          {file.chars !== null && (
            <p className="pg-muted">
              {file.pages !== null ? `${file.pages} pages · ` : ""}
              {file.chars.toLocaleString()} characters read
              {file.truncated
                ? " (the file is longer; only the start is used)"
                : ""}
            </p>
          )}
          {file.excerpt && (
            <blockquote className="pg-knowledge-excerpt">
              {file.excerpt}
              {(file.chars ?? 0) > file.excerpt.length ? "…" : ""}
            </blockquote>
          )}
        </>
      ) : (
        <p className="pg-muted">No file.</p>
      )}
      {problem && (
        <p role="alert" className="pg-knowledge-warn">
          {problem}
        </p>
      )}
      <div className="pg-knowledge-actions">
        {file && file.status !== "removed" && file.status !== "rejected" && (
          <a
            href={
              "/api/agent/knowledge-file?" +
              new URLSearchParams({ id: file.id, download: "1" })
            }
          >
            Download
          </a>
        )}
        {canManage && (
          <>
            <FileButton
              label="Replace file"
              inputLabel="Replacement file"
              accept={DOCUMENT_ACCEPT}
              disabled={!!busy}
              onFile={(chosen) => void replace(chosen)}
            />
            {file && file.status !== "removed" && (
              <button onClick={() => void remove()}>Remove file</button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** A help center theme image: the current one, upload a new one, or none. */
export function ThemeImage({
  label,
  purpose,
  centerId,
  value,
  onChange,
}: {
  label: string;
  purpose: "theme_logo" | "theme_favicon" | "social_image";
  centerId: string;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [state, setState] = useState("");
  const [problem, setProblem] = useState("");
  return (
    <div className="pg-theme-image" role="group" aria-label={label}>
      <span>{label}</span>
      {value ? (
        // Authenticated file proxy: next/image would fetch without the session.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={
            "/api/agent/knowledge-file?" + new URLSearchParams({ id: value })
          }
          alt=""
        />
      ) : (
        <span className="pg-muted">None</span>
      )}
      <FileButton
        label={value ? "Change" : "Upload"}
        inputLabel={`Upload ${label.toLowerCase()}`}
        accept={IMAGE_ACCEPT}
        disabled={!!state}
        onFile={(chosen) => {
          setProblem("");
          void uploadKnowledgeFile(chosen, { purpose, centerId }, (s) =>
            setState(STATUS_WORDS[s]),
          )
            .then((r) => onChange(r.fileId))
            .catch((err) =>
              setProblem(
                err instanceof Error ? err.message : "That did not work.",
              ),
            )
            .finally(() => setState(""));
        }}
      />
      {value && (
        <button type="button" onClick={() => onChange(null)}>
          Remove
        </button>
      )}
      {state && <span role="status">{state}</span>}
      {problem && (
        <span role="alert" className="pg-knowledge-warn">
          {problem}
        </span>
      )}
    </div>
  );
}

/** A button that opens the file picker (a styled label cannot look like the other buttons). */
export function FileButton({
  label,
  inputLabel,
  accept,
  disabled,
  onFile,
}: {
  label: string;
  /** The hidden input's name, for assistive technology and tests. */
  inputLabel: string;
  accept: string;
  disabled?: boolean;
  onFile: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        {label}
      </button>
      <input
        ref={input}
        type="file"
        hidden
        aria-label={inputLabel}
        accept={accept}
        disabled={disabled}
        onChange={(e) => {
          const chosen = e.target.files?.[0];
          e.target.value = "";
          if (chosen) onFile(chosen);
        }}
      />
    </>
  );
}
