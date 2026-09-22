/** Office-hour boundaries are evaluated on the server in the brand's IANA timezone. */
export function officeAvailability(
  office: unknown,
  locale: string,
  now = new Date(),
) {
  if (!office || typeof office !== "object") return { open: false };
  const { timezone, weekly } = office as {
    timezone?: string;
    weekly?: Record<string, string[][]>;
  };
  if (!timezone || !weekly) return { open: false };
  try {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const isOpen = (at: Date) => {
      const fields = Object.fromEntries(
        formatter.formatToParts(at).map((p) => [p.type, p.value]),
      );
      const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
          fields.weekday,
        ),
        time = fields.hour + ":" + fields.minute;
      return (weekly[day] ?? []).some(
        ([from, to]) => time >= from && time < to,
      );
    };
    if (isOpen(now)) return { open: true };
    // Minute boundaries preserve configured office times; DST is interpreted by Intl.
    for (
      let ms = Math.ceil(now.getTime() / 60000) * 60000;
      ms <= now.getTime() + 8 * 86400000;
      ms += 60000
    )
      if (isOpen(new Date(ms))) {
        return {
          open: false,
          nextOpenAt: new Date(ms).toISOString(),
          nextOpenLabel: new Intl.DateTimeFormat(locale, {
            timeZone: timezone,
            weekday: "long",
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short",
          }).format(new Date(ms)),
        };
      }
  } catch {
    /* Invalid configuration is unavailable rather than guessed as UTC. */
  }
  return { open: false };
}
