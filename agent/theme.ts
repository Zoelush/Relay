import { useCallback, useEffect, useState } from "react";

/**
 * The agent app's colour theme (agent dark mode): Light (the default), Dark, or System, which
 * follows the device. The choice is kept in this browser only; where storage is blocked it
 * lasts for the visit and the app starts in Light next time.
 *
 * The resolved theme goes on the root element as `data-agent-theme`, where agent/inbox.css
 * picks its colours, so popups attached outside the app are themed too.
 */
export type ThemeChoice = "system" | "light" | "dark";
export const THEME_CHOICES: ThemeChoice[] = ["system", "light", "dark"];
export const THEME_KEY = "relay.agent.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The saved choice, or Light when there is none, it is unreadable, or storage is blocked. */
export function readChoice(storage: () => Pick<Storage, "getItem">) {
  try {
    const value = storage().getItem(THEME_KEY);
    return THEME_CHOICES.includes(value as ThemeChoice)
      ? (value as ThemeChoice)
      : "light";
  } catch {
    return "light";
  }
}
/** Saves the choice; false when this browser will not keep it. */
export function writeChoice(
  storage: () => Pick<Storage, "setItem">,
  choice: ThemeChoice,
) {
  try {
    storage().setItem(THEME_KEY, choice);
    return true;
  } catch {
    return false;
  }
}
export const resolveTheme = (choice: ThemeChoice, systemDark: boolean) =>
  choice === "system" ? (systemDark ? "dark" : "light") : choice;

const systemDark = () =>
  typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches;
const local = () => window.localStorage;

export function applyTheme(choice: ThemeChoice) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.agentTheme = resolveTheme(choice, systemDark());
  root.dataset.agentThemeChoice = choice;
}
// Before the first render, so a dark choice never flashes light.
if (typeof window !== "undefined") applyTheme(readChoice(local));

/** The teammate's choice, applied, following the device in System and other tabs' changes. */
export function useAgentTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(() =>
    typeof window === "undefined" ? "light" : readChoice(local),
  );
  useEffect(() => {
    applyTheme(choice);
    if (choice !== "system" || typeof matchMedia !== "function") return;
    const query = matchMedia(DARK_QUERY);
    const changed = () => applyTheme("system");
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, [choice]);
  useEffect(() => {
    const changed = (e: StorageEvent) => {
      if (e.key === THEME_KEY) setChoice(readChoice(local));
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  const choose = useCallback((next: ThemeChoice) => {
    writeChoice(local, next);
    setChoice(next);
  }, []);
  return [choice, choose] as const;
}
