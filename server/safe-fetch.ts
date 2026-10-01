/**
 * Fetching addresses that teammates type in (phase 07, step C1b: website sync), without letting
 * them reach anything private.
 *
 * Only public `https://` addresses by host name: no credentials, no IP literals, no single-label
 * or private-use names (localhost, .local, .internal, .home.arpa…), and the default port. Every
 * redirect is checked again, up to five. Bodies are capped (5 MB) and the whole fetch has a time
 * limit (15 seconds). A Worker cannot reach private networks anyway; refusing these names and
 * literals here also keeps cloud metadata and loopback out of reach wherever this runs.
 *
 * `allowHosts` lets tests and the local relay reach their own test site (`127.0.0.1:port`, over
 * http). It is never set when deployed.
 */
export type FetchPolicy = {
  /** Test and local use only: exact `host:port` values allowed over http, loopback included. */
  allowHosts?: string[];
  fetch?: typeof fetch;
};
export type FetchRefusal =
  | "ADDRESS_NOT_ALLOWED"
  | "TOO_MANY_REDIRECTS"
  | "TOO_LARGE"
  | "TIMEOUT"
  | "UNREACHABLE";
export class FetchRefused extends Error {
  constructor(public code: FetchRefusal) {
    super(code);
  }
}
export const MAX_PAGE_BYTES = 5 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
export const USER_AGENT = "RelayBot/1.0 (Relay knowledge sync)";

const PRIVATE_NAMES =
  /(^|\.)(localhost|local|internal|intranet|lan|home|corp|home\.arpa|localdomain)$/i;

/** The address if it may be fetched under this policy, or a refusal. */
export function checkAddress(raw: string, policy: FetchPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchRefused("ADDRESS_NOT_ALLOWED");
  }
  if (url.username || url.password)
    throw new FetchRefused("ADDRESS_NOT_ALLOWED");
  if (policy.allowHosts?.includes(url.host)) {
    if (url.protocol === "http:" || url.protocol === "https:") return url;
    throw new FetchRefused("ADDRESS_NOT_ALLOWED");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    (url.port && url.port !== "443") ||
    // IP literals (v4, and v6 in brackets): public sites are reached by name.
    /^[\d.]+$/.test(host) ||
    host.startsWith("[") ||
    !host.includes(".") ||
    host.endsWith(".") ||
    PRIVATE_NAMES.test(host)
  )
    throw new FetchRefused("ADDRESS_NOT_ALLOWED");
  return url;
}

export type Fetched = {
  status: number;
  /** Where the content finally came from, after redirects. */
  url: string;
  headers: Headers;
  body: string;
};

/**
 * GET with the checks above. Redirects are followed by hand so each hop is checked; a 304 or
 * an error status comes back with an empty body.
 */
export async function safeFetch(
  raw: string,
  policy: FetchPolicy = {},
  headers: Record<string, string> = {},
  limits: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<Fetched> {
  const send = policy.fetch ?? fetch;
  const signal = AbortSignal.timeout(limits.timeoutMs ?? FETCH_TIMEOUT_MS);
  let url = checkAddress(raw, policy);
  try {
    for (let hop = 0; ; hop++) {
      const response = await send(url.toString(), {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { "user-agent": USER_AGENT, ...headers },
      });
      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.status !== 304
      ) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location)
          return {
            status: response.status,
            url: url.toString(),
            headers: response.headers,
            body: "",
          };
        if (hop >= MAX_REDIRECTS) throw new FetchRefused("TOO_MANY_REDIRECTS");
        url = checkAddress(new URL(location, url).toString(), policy);
        continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        return {
          status: response.status,
          url: url.toString(),
          headers: response.headers,
          body: "",
        };
      }
      return {
        status: 200,
        url: url.toString(),
        headers: response.headers,
        body: await readCapped(response, limits.maxBytes ?? MAX_PAGE_BYTES),
      };
    }
  } catch (e) {
    if (e instanceof FetchRefused) throw e;
    if (signal.aborted) throw new FetchRefused("TIMEOUT");
    throw new FetchRefused("UNREACHABLE");
  }
}

async function readCapped(response: Response, max: number) {
  const declared = Number(response.headers.get("content-length"));
  if (declared > max) {
    await response.body?.cancel();
    throw new FetchRefused("TOO_LARGE");
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        throw new FetchRefused("TOO_LARGE");
      }
      chunks.push(value);
    }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  const charset = /charset=([\w-]+)/i.exec(
    response.headers.get("content-type") ?? "",
  )?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
