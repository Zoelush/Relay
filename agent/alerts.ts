/**
 * How Relay gets a teammate's attention when a notification arrives (Settings › Notifications):
 * a desktop notification while the tab is in the background, and a short chime. Both follow the
 * teammate's saved preferences; both fail quietly where the browser refuses them.
 */
export type AlertPrefs = { desktop: boolean; sound: boolean };

/** Whether this browser can show desktop notifications, and what it currently allows. */
export function desktopPermission():
  "unsupported" | "default" | "granted" | "denied" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}
export async function askDesktopPermission() {
  if (typeof Notification === "undefined") return "unsupported" as const;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** Two soft notes, about a third of a second, at a gentle volume. */
export function playChime() {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    for (const [i, freq] of [880, 1320].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = now + i * 0.14;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.25);
    }
    setTimeout(() => void ctx.close(), 800);
  } catch {
    // Audio blocked (no user gesture yet, or no device): stay silent.
  }
}

/** A new notification arrived: tell the teammate in the ways they chose. */
export function alertTeammate(prefs: AlertPrefs, count: number) {
  if (prefs.sound) playChime();
  if (
    prefs.desktop &&
    typeof document !== "undefined" &&
    document.hidden &&
    desktopPermission() === "granted"
  ) {
    try {
      new Notification("Relay", {
        body:
          count === 1
            ? "You have a new notification."
            : `You have ${count} unread notifications.`,
        tag: "relay-notifications",
      });
    } catch {
      // Some browsers only allow notifications from a service worker: skip.
    }
  }
}
