import { within } from "../lib/links";

/**
 * Link reputation (phase 16, step C7a; docs/SECURITY_STEP11.md): whether addresses are known
 * phishing or malware. Deployed, Google Safe Browsing's Lookup API (only the addresses are sent;
 * listed in `lib/processors.ts`); locally and in tests, a stand-in. Without either, only the checks
 * in code (`lib/links.ts`) apply.
 */
export type LinkReputation = {
  name: string;
  /** The threat type for each flagged address; addresses not returned are clean. */
  check(urls: string[]): Promise<Record<string, string>>;
};

export function safeBrowsing(key: string, fetcher: typeof fetch = fetch): LinkReputation {
  return {
    name: "Google Safe Browsing",
    async check(urls) {
      const found: Record<string, string> = {};
      for (let i = 0; i < urls.length; i += 500) {
        const r = await fetcher(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(key)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client: { clientId: "relay", clientVersion: "1" },
            threatInfo: {
              threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
              platformTypes: ["ANY_PLATFORM"],
              threatEntryTypes: ["URL"],
              threatEntries: urls.slice(i, i + 500).map((url) => ({ url })),
            },
          }),
        });
        if (!r.ok) throw new Error(`Safe Browsing answered ${r.status}`);
        const body = (await r.json()) as { matches?: { threatType: string; threat: { url: string } }[] };
        for (const m of body.matches ?? []) found[m.threat.url] = m.threatType;
      }
      return found;
    },
  };
}

/** The stand-in: anything at malware.test or phishing.test is flagged. */
export function standInReputation(): LinkReputation {
  return {
    name: "Stand-in",
    async check(urls) {
      const found: Record<string, string> = {};
      for (const url of urls) {
        const host = new URL(url).hostname;
        if (within(host, "malware.test")) found[url] = "MALWARE";
        else if (within(host, "phishing.test")) found[url] = "SOCIAL_ENGINEERING";
      }
      return found;
    },
  };
}
