import { createContext, useContext } from "react";
import { Sparkles } from "lucide-react";

/**
 * Colour in the agent app (phase 08 Z1; docs/AI_STEP5.md). Neutrals stay neutral; colour marks
 * meaning, as in Beacon and Intercom: each area of the icon strip and each menu entry has a tint,
 * people get a stable colour in their avatar, and Zoe has her own teal-to-emerald mark. The tints
 * are tokens in agent/inbox.css (light and dark), applied with `data-hue`.
 */
export const HUES = [
  "blue",
  "violet",
  "rose",
  "amber",
  "teal",
  "green",
  "sky",
  "slate",
] as const;
export type Hue = (typeof HUES)[number] | "zoe";

/** A stable tint for a person, team or view: the same key always gets the same colour. */
export function hueOf(key: string): Hue {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return HUES[Math.abs(h) % HUES.length];
}

/** Zoe's mark: her sparkle on the teal-to-emerald gradient. */
export function ZoeMark({
  size = 20,
  className = "",
  label,
}: {
  size?: number;
  className?: string;
  /** When the mark stands alone, its accessible name. */
  label?: string;
}) {
  return (
    <span
      className={"pg-zoe-mark " + className}
      style={{ width: size, height: size }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <Sparkles size={Math.round(size * 0.58)} aria-hidden="true" />
    </span>
  );
}

/** The AI agent's name in this workspace (Zoe unless renamed), for her replies and views. */
export const AgentName = createContext("Zoe");
export const useAgentName = () => useContext(AgentName);
