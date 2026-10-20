import { useEffect, useState } from "react";
import {
  Bell,
  Building2,
  Globe,
  LifeBuoy,
  ListFilter,
  Monitor,
  Moon,
  Palette,
  Sparkles,
  HeartPulse,
  Sun,
  User,
  Zap,
  Users,
  Clock,
  Timer,
  Tag,
  SlidersHorizontal,
  Ticket,
  UserCog,
  ShieldCheck,
  Store,
  MessageCircle,
  DoorOpen,
  type LucideIcon,
  Bot,
  Workflow,
  Ban,
  Mail,
  Smartphone,
  AtSign,
  Hash,
  Phone,
  Activity,
  BellOff,
  BarChart3,
} from "lucide-react";
import { api } from "./api";
import { hueOf, type Hue } from "./colour";
import { ShowMenuButton, SideMenu, useSideMenu } from "./shell";
import {
  Card,
  deviceZone,
  Field,
  Frame,
  message,
  timezones,
  useForm,
  type MenuState,
  type Page,
} from "./settings-ui";
import { MacroManager, type MacroList } from "./macros";
import { OfficeHoursPage, SlasPage, TeamsPage } from "./settings-helpdesk";
import { SuppressionsPage } from "./settings-suppressions";
import { EmailPage } from "./settings-email";
import { WhatsAppPage } from "./settings-whatsapp";
import { SmsPage } from "./settings-sms";
import { MetaPage } from "./settings-meta";
import { CommunityPage } from "./settings-community";
import { VoicePage } from "./settings-voice";
import { EventsPage, OutboundPage, SubscriptionsPage } from "./settings-outbound";
import { ReportingPage } from "./settings-reporting";
import { AttributesPage, TagsPage, TicketTypesPage } from "./settings-data";
import { RolesPage, TeammatesPage } from "./settings-people";
import { BrandsPage, MessengerPage, PortalPage } from "./settings-channels";
import type { Directory } from "./timeline";
import type { ThemeChoice } from "./theme";
import {
  askDesktopPermission,
  desktopPermission,
  playChime,
  type AlertPrefs,
} from "./alerts";

/**
 * Settings (S1; docs/SETTINGS_STEP1.md): one area, opened from the gear in the icon strip, for
 * everything a teammate or a workspace manager can configure. A grouped side menu (like the
 * inbox's) and a home page of cards; every page has an address (`#settings/<page>`), so other
 * parts of the app can link straight to one. Pages show only to teammates who may use them (the
 * server lists them); features managed elsewhere (Knowledge, saved views) are linked, not copied.
 */
type Link =
  | "views"
  | "help-centers"
  | "websites"
  | "ai-index"
  | "content-health"
  | "ai-agent"
  | "workflows";

const PAGES: Page[] = [
  {
    id: "profile",
    label: "Your profile",
    description:
      "How you appear to teammates and customers, your timezone, and your reply signature.",
    icon: User,
    group: "Personal",
  },
  {
    id: "notifications",
    label: "Notifications",
    description: "How Relay gets your attention when someone mentions you.",
    icon: Bell,
    group: "Personal",
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Light, dark, or follow your device.",
    icon: Palette,
    group: "Personal",
  },
  {
    id: "general",
    label: "General",
    description: "Your workspace's name, timezone and team language.",
    icon: Building2,
    group: "Workspace",
  },
  {
    id: "teammates",
    label: "Teammates",
    description: "Everyone in the workspace, and the role each one has.",
    icon: UserCog,
    group: "Workspace",
  },
  {
    id: "roles",
    label: "Roles & permissions",
    description: "What each role lets a teammate do, and roles of your own.",
    icon: ShieldCheck,
    group: "Workspace",
  },
  {
    id: "teams",
    label: "Teams & assignment",
    description:
      "Teams, their members, how conversations are assigned, and limits.",
    icon: Users,
    group: "Helpdesk",
  },
  {
    id: "office-hours",
    label: "Office hours",
    description:
      "When your team works, and which teams and brands use which hours.",
    icon: Clock,
    group: "Helpdesk",
  },
  {
    id: "slas",
    label: "SLAs",
    description: "Response and resolution targets, and when they apply.",
    icon: Timer,
    group: "Helpdesk",
  },
  {
    id: "tags",
    label: "Tags",
    description: "Tags for grouping conversations: add, rename and archive.",
    icon: Tag,
    group: "Helpdesk",
  },
  {
    id: "attributes",
    label: "Attributes",
    description:
      "Details teammates fill in on conversations, such as an order number.",
    icon: SlidersHorizontal,
    group: "Helpdesk",
  },
  {
    id: "ticket-types",
    label: "Ticket types",
    description: "Each type's states, the moves between them, and its fields.",
    icon: Ticket,
    group: "Helpdesk",
  },
  {
    id: "brands",
    label: "Brands",
    description: "Your brands, each with its own messenger and portal.",
    icon: Store,
    group: "Channels",
  },
  {
    id: "messenger",
    label: "Messenger",
    description:
      "Each brand's messenger: look, greeting, websites, identity and install.",
    icon: MessageCircle,
    group: "Channels",
  },
  {
    id: "portal",
    label: "Customer portal",
    description:
      "Who sees which requests, portal addresses and custom domains.",
    icon: DoorOpen,
    group: "Channels",
  },
  {
    // Phase 12 E2: each brand's inbound address and forwarding.
    id: "email",
    label: "Email",
    description: "Inbound addresses, forwarding from your support address, and the latest mail.",
    icon: Mail,
    group: "Channels",
  },
  {
    // Phase 12 E5: WhatsApp numbers, templates and opt-ins.
    id: "whatsapp",
    label: "WhatsApp",
    description: "Connect a WhatsApp Business number, its message templates, and opt-ins.",
    icon: MessageCircle,
    group: "Channels",
  },
  {
    // Phase 12 E6: the Twilio account, numbers per country, prices and consent.
    id: "sms",
    label: "SMS",
    description: "Connect Twilio, the numbers you text from, what a text costs, and consent.",
    icon: Smartphone,
    group: "Channels",
  },
  {
    // Phase 12 E7: a Facebook Page's Messenger and its linked Instagram account.
    id: "meta",
    label: "Instagram & Facebook",
    description: "Connect a Facebook Page and its Instagram account to answer their messages.",
    icon: AtSign,
    group: "Channels",
  },
  {
    // Phase 12 E8: community messages from Slack and Discord.
    id: "community",
    label: "Slack & Discord",
    description: "Connect a Slack workspace or Discord server: its messages become conversations.",
    icon: Hash,
    group: "Channels",
  },
  {
    // Phase 12 E9: calls, through the SMS account's numbers.
    id: "voice",
    label: "Voice",
    description: "Take calls on your numbers: recording consent, Zoe on the phone, transfers and voicemail.",
    icon: Phone,
    group: "Channels",
  },
  {
    // Phase 14 R1: reporting's data, and what each number means.
    id: "reporting",
    label: "Reporting data",
    description: "How current reports are, and what each metric means.",
    icon: BarChart3,
    group: "Reports",
  },
  {
    // Phase 13 O2: the limits every outbound message is held to.
    id: "outbound",
    label: "Limits",
    description: "How many messages anyone gets, across all outbound, and quiet hours.",
    icon: Timer,
    group: "Outbound",
  },
  {
    // Phase 13 O1: the kinds of message people choose to get.
    id: "subscriptions",
    label: "Subscriptions",
    description: "Opt-in and opt-out types every outbound message declares, and who chose what.",
    icon: BellOff,
    group: "Outbound",
  },
  {
    // Phase 13 O1: what people do, sent by the messenger or your server.
    id: "events",
    label: "Events",
    description: "What people do in your product, for segments and outbound.",
    icon: Activity,
    group: "Outbound",
  },
  {
    // Phase 12 E1: addresses nothing is sent to, on any channel.
    id: "suppressions",
    label: "Suppression list",
    description: "Addresses nothing is sent to: bounces, complaints, opt-outs and blocks.",
    icon: Ban,
    group: "Channels",
  },
  {
    id: "macros",
    label: "Macros",
    description: "Saved replies and actions, your own or shared with the team.",
    icon: Zap,
    group: "Inbox",
  },
  {
    id: "views",
    label: "Saved views",
    description: "Your views and team inboxes, managed from the inbox menu.",
    icon: ListFilter,
    group: "Inbox",
    link: true,
  },
  {
    // Workflows have their own area (phase 11 W2); Settings links to it.
    id: "workflows",
    label: "Workflows",
    description: "Tag, route, prioritise and hand over conversations automatically.",
    icon: Workflow,
    group: "Inbox",
    link: true,
  },
  {
    id: "help-centers",
    label: "Help centers",
    description:
      "Public help centers per brand: collections, look and addresses.",
    icon: LifeBuoy,
    group: "Knowledge & AI",
    link: true,
  },
  {
    id: "websites",
    label: "Websites",
    description: "Websites synced into knowledge on a schedule.",
    icon: Globe,
    group: "Knowledge & AI",
    link: true,
  },
  {
    id: "ai-index",
    label: "AI index",
    description:
      "What the AI agent can search, with which model, and re-embedding.",
    icon: Sparkles,
    group: "Knowledge & AI",
    link: true,
  },
  {
    // Zoe has her own area now (phase 08 Z1); Settings links to it.
    id: "ai-agent",
    label: "Zoe, AI agent",
    description:
      "Her identity, how she answers and hands over, and what she resolved.",
    icon: Bot,
    group: "Knowledge & AI",
    link: true,
  },
  {
    id: "content-health",
    label: "Content health",
    description:
      "Content never reviewed, not used in 90 days, or nearly duplicated.",
    icon: HeartPulse,
    group: "Knowledge & AI",
    link: true,
  },
];
const GROUPS = [
  "Personal",
  "Workspace",
  "Helpdesk",
  "Channels",
  "Outbound",
  "Reports",
  "Inbox",
  "Knowledge & AI",
];
export const SETTINGS_PAGES = PAGES.map((p) => p.id);
/** Each group's tint (Z1), on its pages' icons in the menu and on Settings home. */
const GROUP_HUES: Record<string, Hue> = {
  Personal: "sky",
  Workspace: "violet",
  Helpdesk: "blue",
  Channels: "teal",
  Outbound: "green",
  Reports: "violet",
  Inbox: "amber",
  "Knowledge & AI": "rose",
};
const hueFor = (p: Page): Hue =>
  p.id === "ai-agent" ? "zoe" : (GROUP_HUES[p.group] ?? "slate");

const LANGUAGES = [
  "en",
  "en-GB",
  "fr",
  "de",
  "es",
  "pt",
  "pt-BR",
  "it",
  "nl",
  "ar",
  "tr",
  "pl",
  "sv",
  "zh",
  "ja",
  "ko",
  "hi",
  "sw",
  "yo",
  "ha",
  "ig",
];
const languageName = (tag: string) => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
};

export function Settings({
  page,
  onPage,
  theme,
  onTheme,
  macros,
  onLink,
  onProfile,
  onDirectory,
}: {
  page: string;
  onPage: (page: string) => void;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
  macros: { list: MacroList | null; dir: Directory; onChanged: () => void };
  /** Opens a feature where it lives: Knowledge's pages, or the inbox menu's views. */
  onLink: (target: Link) => void;
  /** Your profile changed: the app updates your name, signature and alerts. */
  onProfile: (profile: Profile) => void;
  /** Teams or tags changed: the app reloads its directory of names. */
  onDirectory?: () => void;
}) {
  const menu = useSideMenu("settings");
  // The brand the Messenger page shows; the Brands page can open one directly.
  const [messengerBrand, setMessengerBrand] = useState("default");
  const [allowed, setAllowed] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ pages: string[] }>("settings?section=overview")
      .then((r) => setAllowed(r.pages))
      .catch((e) => setError(message(e, "Settings could not be loaded.")));
  }, []);
  const visible = PAGES.filter((p) => allowed?.includes(p.id));
  const current = visible.find((p) => p.id === page);
  const open = (p: Page) => (p.link ? onLink(p.id as Link) : onPage(p.id));
  return (
    <section className="pg-workspace pg-settings" aria-label="Settings">
      <div className="pg-area">
        <SideMenu state={menu} title="Settings" label="Settings menu">
          <nav aria-label="Settings pages">
            <ul className="pg-menu-entries">
              <li>
                <button
                  aria-current={!current ? "page" : undefined}
                  onClick={() => onPage("home")}
                >
                  <span className="pg-menu-entry-name">Overview</span>
                </button>
              </li>
            </ul>
            {GROUPS.map((g) => {
              const items = visible.filter((p) => p.group === g);
              if (!items.length) return null;
              return (
                <section key={g} className="pg-menu-section">
                  <h2 className="pg-settings-group">{g}</h2>
                  <ul className="pg-menu-entries">
                    {items.map((p) => (
                      <li key={p.id} data-hue={hueFor(p)}>
                        <button
                          aria-current={
                            current?.id === p.id ? "page" : undefined
                          }
                          onClick={() => open(p)}
                        >
                          <span
                            className="pg-menu-entry-icon"
                            aria-hidden="true"
                          >
                            <p.icon size={16} />
                          </span>
                          <span className="pg-menu-entry-name">{p.label}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </nav>
        </SideMenu>
        <div className="pg-area-main">
          {error && (
            <div className="pg-error" role="alert">
              {error}
            </div>
          )}
          {!current ? (
            <SettingsHome
              menu={menu}
              pages={visible}
              ready={!!allowed}
              onOpen={open}
            />
          ) : current.id === "profile" ? (
            <ProfilePage menu={menu} page={current} onSaved={onProfile} />
          ) : current.id === "notifications" ? (
            <NotificationsPage menu={menu} page={current} onSaved={onProfile} />
          ) : current.id === "appearance" ? (
            <AppearancePage
              menu={menu}
              page={current}
              theme={theme}
              onTheme={onTheme}
            />
          ) : current.id === "general" ? (
            <GeneralPage menu={menu} page={current} />
          ) : current.id === "teammates" ? (
            <TeammatesPage menu={menu} page={current} />
          ) : current.id === "roles" ? (
            <RolesPage menu={menu} page={current} />
          ) : current.id === "brands" ? (
            <BrandsPage
              menu={menu}
              page={current}
              onMessenger={
                visible.some((p) => p.id === "messenger")
                  ? (id) => {
                      setMessengerBrand(id);
                      onPage("messenger");
                    }
                  : undefined
              }
            />
          ) : current.id === "messenger" ? (
            <MessengerPage
              menu={menu}
              page={current}
              brandId={messengerBrand}
              onBrand={setMessengerBrand}
            />
          ) : current.id === "portal" ? (
            <PortalPage menu={menu} page={current} />
          ) : current.id === "teams" ? (
            <TeamsPage menu={menu} page={current} onChanged={onDirectory} />
          ) : current.id === "office-hours" ? (
            <OfficeHoursPage menu={menu} page={current} />
          ) : current.id === "slas" ? (
            <SlasPage menu={menu} page={current} />
          ) : current.id === "reporting" ? (
            <ReportingPage menu={menu} page={current} />
          ) : current.id === "outbound" ? (
            <OutboundPage menu={menu} page={current} />
          ) : current.id === "events" ? (
            <EventsPage menu={menu} page={current} />
          ) : current.id === "subscriptions" ? (
            <SubscriptionsPage menu={menu} page={current} />
          ) : current.id === "voice" ? (
            <VoicePage menu={menu} page={current} />
          ) : current.id === "community" ? (
            <CommunityPage menu={menu} page={current} />
          ) : current.id === "meta" ? (
            <MetaPage menu={menu} page={current} />
          ) : current.id === "sms" ? (
            <SmsPage menu={menu} page={current} />
          ) : current.id === "whatsapp" ? (
            <WhatsAppPage menu={menu} page={current} />
          ) : current.id === "email" ? (
            <EmailPage menu={menu} page={current} />
          ) : current.id === "suppressions" ? (
            <SuppressionsPage menu={menu} page={current} />
          ) : current.id === "tags" ? (
            <TagsPage menu={menu} page={current} onChanged={onDirectory} />
          ) : current.id === "attributes" ? (
            <AttributesPage menu={menu} page={current} />
          ) : current.id === "ticket-types" ? (
            <TicketTypesPage menu={menu} page={current} />
          ) : current.id === "macros" ? (
            <Frame menu={menu} page={current}>
              <MacroManager
                embedded
                list={macros.list}
                dir={macros.dir}
                onChanged={macros.onChanged}
                onClose={() => onPage("home")}
              />
            </Frame>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export type Profile = {
  name: string;
  role: string;
  timezone: string | null;
  signature: string;
  notifications: AlertPrefs;
};
function SettingsHome({
  menu,
  pages,
  ready,
  onOpen,
}: {
  menu: MenuState;
  pages: Page[];
  ready: boolean;
  onOpen: (p: Page) => void;
}) {
  return (
    <div className="pg-settings-page">
      <header className="pg-top pg-settings-head">
        <ShowMenuButton state={menu} />
        <div>
          <h2>Settings</h2>
          <p className="pg-muted">
            Everything you can set up in Relay, for yourself and your workspace.
          </p>
        </div>
      </header>
      <div className="pg-settings-body" aria-busy={!ready}>
        {GROUPS.map((g) => {
          const items = pages.filter((p) => p.group === g);
          if (!items.length) return null;
          return (
            <section key={g} className="pg-settings-home-group" aria-label={g}>
              <h3>{g}</h3>
              <div className="pg-settings-grid">
                {items.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="pg-settings-tile"
                    data-hue={hueFor(p)}
                    onClick={() => onOpen(p)}
                  >
                    <span className="pg-settings-tile-icon" aria-hidden="true">
                      <p.icon size={18} />
                    </span>
                    <span>
                      <strong>{p.label}</strong>
                      <small>{p.description}</small>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ProfilePage({
  menu,
  page,
  onSaved,
}: {
  menu: MenuState;
  page: Page;
  onSaved: (p: Profile) => void;
}) {
  const f = useForm("profile", (d) => ({
    name: String(d.name ?? ""),
    timezone: (d.timezone as string | null) ?? "",
    signature: String(d.signature ?? ""),
  }));
  const zones = timezones(f.form?.timezone);
  return (
    <Frame
      menu={menu}
      page={page}
      save={{
        dirty: f.dirty,
        busy: f.busy,
        saved: f.done,
        error: f.error,
        onSave: () =>
          void f
            .save({ section: "profile", ...f.form })
            .then((d) => d && onSaved(d as unknown as Profile)),
      }}
    >
      {f.form && (
        <>
          <Card
            title="Identity"
            description="Shown to teammates, and to customers on your replies."
          >
            <div className="pg-settings-identity">
              <span
                className="pg-avatar"
                data-hue={hueOf(f.form.name)}
                aria-hidden="true"
              >
                {f.form.name
                  .split(/\s+/)
                  .filter(Boolean)
                  .slice(0, 2)
                  .map((w) => w[0])
                  .join("")
                  .toUpperCase() || "?"}
              </span>
              <span className="pg-muted">
                Role: {String(f.extra?.role ?? "")}
              </span>
            </div>
            <Field label="Name">
              {(id) => (
                <input
                  id={id}
                  value={f.form!.name}
                  maxLength={80}
                  required
                  onChange={(e) =>
                    f.setForm({ ...f.form!, name: e.target.value })
                  }
                />
              )}
            </Field>
            <Field
              label="Timezone"
              hint="Used for your working hours. Times in the inbox follow your device."
            >
              {(id, hint) => (
                <select
                  id={id}
                  aria-describedby={hint}
                  value={f.form!.timezone}
                  onChange={(e) =>
                    f.setForm({ ...f.form!, timezone: e.target.value })
                  }
                >
                  <option value="">Your device&apos;s ({deviceZone()})</option>
                  {zones.map((z) => (
                    <option key={z} value={z}>
                      {z.replaceAll("_", " ")}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </Card>
          <Card
            title="Reply signature"
            description="Added to the end of every reply you send from the inbox. Not added to internal notes."
          >
            <Field
              label="Signature"
              hint="Up to 1,000 characters. Leave empty for none."
            >
              {(id, hint) => (
                <textarea
                  id={id}
                  aria-describedby={hint}
                  rows={4}
                  maxLength={1000}
                  value={f.form!.signature}
                  placeholder={"Best wishes,\nAda from the support team"}
                  onChange={(e) =>
                    f.setForm({ ...f.form!, signature: e.target.value })
                  }
                />
              )}
            </Field>
          </Card>
        </>
      )}
    </Frame>
  );
}

function NotificationsPage({
  menu,
  page,
  onSaved,
}: {
  menu: MenuState;
  page: Page;
  onSaved: (p: Profile) => void;
}) {
  const f = useForm("profile", (d) => ({
    ...((d.notifications as AlertPrefs) ?? { desktop: false, sound: false }),
  }));
  const [permission, setPermission] = useState(desktopPermission);
  return (
    <Frame
      menu={menu}
      page={page}
      save={{
        dirty: f.dirty,
        busy: f.busy,
        saved: f.done,
        error: f.error,
        onSave: () =>
          void f
            .save({ section: "notifications", notifications: f.form })
            .then((d) => d && onSaved(d as unknown as Profile)),
      }}
    >
      {f.form && (
        <Card
          title="When someone mentions you"
          description="Mentions and other notifications always appear under the bell. These add to it, and follow your account on every device you sign in on."
        >
          <label className="pg-settings-toggle">
            <input
              type="checkbox"
              checked={f.form.desktop}
              onChange={async (e) => {
                const on = e.target.checked;
                if (on && permission !== "granted")
                  setPermission(await askDesktopPermission());
                f.setForm({ ...f.form!, desktop: on });
              }}
            />
            <span>
              <strong>Desktop notifications</strong>
              <small className="pg-muted">
                Shown while Relay is in a background tab or window.
                {permission === "denied" &&
                  " Your browser is blocking them: allow notifications for this site first."}
                {permission === "unsupported" &&
                  " This browser can't show them."}
              </small>
            </span>
          </label>
          <label className="pg-settings-toggle">
            <input
              type="checkbox"
              checked={f.form.sound}
              onChange={(e) =>
                f.setForm({ ...f.form!, sound: e.target.checked })
              }
            />
            <span>
              <strong>Play a sound</strong>
              <small className="pg-muted">A short, soft chime.</small>
            </span>
          </label>
          <div>
            <button type="button" onClick={playChime}>
              Play the sound
            </button>
          </div>
        </Card>
      )}
    </Frame>
  );
}

function AppearancePage({
  menu,
  page,
  theme,
  onTheme,
}: {
  menu: MenuState;
  page: Page;
  theme: ThemeChoice;
  onTheme: (c: ThemeChoice) => void;
}) {
  const choices: [ThemeChoice, string, LucideIcon][] = [
    ["system", "System", Monitor],
    ["light", "Light", Sun],
    ["dark", "Dark", Moon],
  ];
  return (
    <Frame menu={menu} page={page}>
      <Card
        title="Theme"
        description="Applies at once, and is kept in this browser. System follows your device's light or dark setting."
      >
        <div
          className="pg-theme pg-settings-theme"
          role="radiogroup"
          aria-label="Theme"
        >
          {choices.map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={theme === value}
              onClick={() => onTheme(value)}
            >
              <Icon size={14} aria-hidden="true" /> {label}
            </button>
          ))}
        </div>
      </Card>
    </Frame>
  );
}

function GeneralPage({ menu, page }: { menu: MenuState; page: Page }) {
  const f = useForm("general", (d) => ({
    name: String(d.name ?? ""),
    timezone: String(d.timezone ?? "UTC"),
    language: String(d.language ?? "en"),
  }));
  const counts = f.extra?.counts as
    { teammates: number; contacts: number; conversations: number } | undefined;
  const languages =
    f.form && !LANGUAGES.includes(f.form.language)
      ? [f.form.language, ...LANGUAGES]
      : LANGUAGES;
  return (
    <Frame
      menu={menu}
      page={page}
      save={{
        dirty: f.dirty,
        busy: f.busy,
        saved: f.done,
        error: f.error,
        onSave: () => void f.save({ section: "general", ...f.form }),
      }}
    >
      {counts && (
        <div className="pg-settings-stats">
          {(
            [
              ["Teammates", counts.teammates],
              ["Contacts", counts.contacts],
              ["Conversations", counts.conversations],
            ] as const
          ).map(([label, n]) => (
            <div key={label}>
              <small>{label}</small>
              <strong>{n.toLocaleString()}</strong>
            </div>
          ))}
        </div>
      )}
      {f.form && (
        <>
          <Card
            title="Workspace"
            description="Shown to teammates in the account menu."
          >
            <Field label="Workspace name">
              {(id) => (
                <input
                  id={id}
                  value={f.form!.name}
                  maxLength={80}
                  required
                  onChange={(e) =>
                    f.setForm({ ...f.form!, name: e.target.value })
                  }
                />
              )}
            </Field>
            <Field
              label="Workspace ID"
              hint="Fixed once a workspace is created."
            >
              {(id, hint) => (
                <input
                  id={id}
                  aria-describedby={hint}
                  value={String(f.extra?.id ?? "")}
                  readOnly
                  className="pg-mono"
                />
              )}
            </Field>
            <Field
              label="Timezone"
              hint="The clock your team works to, for office hours and reports."
            >
              {(id, hint) => (
                <select
                  id={id}
                  aria-describedby={hint}
                  value={f.form!.timezone}
                  onChange={(e) =>
                    f.setForm({ ...f.form!, timezone: e.target.value })
                  }
                >
                  {timezones(f.form!.timezone).map((z) => (
                    <option key={z} value={z}>
                      {z.replaceAll("_", " ")}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </Card>
          <Card
            title="Language"
            description="The language your team works in. Help centers and the messenger choose their own languages."
          >
            <Field label="Team language">
              {(id) => (
                <select
                  id={id}
                  value={f.form!.language}
                  onChange={(e) =>
                    f.setForm({ ...f.form!, language: e.target.value })
                  }
                >
                  {languages.map((l) => (
                    <option key={l} value={l}>
                      {languageName(l)} ({l})
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </Card>
        </>
      )}
    </Frame>
  );
}
