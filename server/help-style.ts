import { contrast, FONTS, luminance, readableOn, shade, type Background, type FontId, type HelpTheme, type LayoutBlock } from "../lib/help-theme";

/**
 * The help center's stylesheet (the November 2026 rebuild; docs/HELP_CENTER_DESIGN.md). Fixed
 * text, so its CSP hash is stable; everything a help center chooses (colours, fonts, radius, the
 * hero, the cards, the footer) is a second block of CSS variables and a few rules, from
 * `themeCss`. No inline styles and no script.
 */
export const HELP_CSS = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font-b);font-size:16px;line-height:1.6}
h1,h2,h3,h4,.brand,.card strong,.hero-line{font-family:var(--font-h)}
a{color:var(--link)}
a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid var(--action);outline-offset:2px;border-radius:4px}
.skip{position:absolute;left:-999px}.skip:focus{left:16px;top:8px;background:var(--bg);padding:6px 10px;z-index:2}
.wrap{max-width:1080px;margin:0 auto;padding:0 20px}

.hero{background:var(--hero-bg);background-size:cover;background-position:center;color:var(--hero-text);display:flex;flex-direction:column;position:relative}
.hero a{color:inherit}
.hero-home{min-height:var(--hero-h)}
.hero-fade.hero-home::after{content:"";position:absolute;left:0;right:0;bottom:0;height:35%;background:linear-gradient(to bottom,transparent,var(--bg));pointer-events:none}
.top{background:var(--header-bg);color:var(--header-text);position:relative;z-index:1}
.top-inner{display:flex;gap:18px;align-items:center;flex-wrap:wrap;padding-top:18px;padding-bottom:18px}
.brand{display:inline-flex;align-items:center;gap:10px;font-weight:700;font-size:21px;letter-spacing:-.01em;text-decoration:none;margin-inline-end:auto}
.brand img{display:block;max-height:40px;max-width:220px}
.top nav{display:flex;gap:18px;align-items:center;flex-wrap:wrap;font-size:14.5px}
.top nav a{text-decoration:none;opacity:.9}.top nav a:hover{opacity:1;text-decoration:underline}
.langs{display:flex;gap:10px;flex-wrap:wrap;list-style:none;margin:0;padding:0}
.langs [aria-current]{font-weight:700;opacity:1}
.hero-body{flex:1;display:flex;flex-direction:column;justify-content:var(--hero-justify);padding-top:10px;padding-bottom:30px;position:relative;z-index:1}
.hero-home .hero-body{padding-top:18px;padding-bottom:44px}
.hero-inner{display:flex;flex-direction:column;align-items:var(--hero-align);text-align:var(--hero-textalign)}
.hero-line{margin:0 0 20px;font-size:32px;line-height:1.2;letter-spacing:-.015em;font-weight:700}
.search{position:relative;display:flex;align-items:center;width:100%;max-width:680px}
.hero-home .search{max-width:var(--search-w)}
.search-icon{position:absolute;inset-inline-start:16px;top:50%;transform:translateY(-50%);opacity:.6;pointer-events:none;color:#161a1d}
.search input{flex:1;min-width:0;height:54px;padding:0 110px 0 46px;font:inherit;font-size:16px;border:1px solid rgba(0,0,0,.08);border-radius:var(--search-r);background:#ffffff;color:#161a1d;box-shadow:0 1px 2px rgba(16,24,32,.06),0 8px 24px -16px rgba(16,24,32,.3)}
[dir=rtl] .search input{padding:0 46px 0 110px}
.search input::placeholder{color:#5c6670}
.search input:focus{border-color:var(--action);outline:none;box-shadow:0 0 0 4px var(--soft)}
.search button{position:absolute;inset-inline-end:7px;top:7px;height:40px;padding:0 16px;font:inherit;font-size:14.5px;font-weight:600;border:0;border-radius:max(calc(var(--search-r) - 4px),0px);background:var(--action);color:var(--on-action);cursor:pointer}

main{max-width:1080px;margin:0 auto;padding:30px 20px 64px}
.crumbs ol{display:flex;flex-wrap:wrap;gap:6px;list-style:none;margin:0 0 22px;padding:0;font-size:13.5px;color:var(--muted)}
.crumbs a{color:var(--muted);text-decoration:none}.crumbs a:hover{text-decoration:underline;color:var(--text)}
.crumbs li+li::before{content:"›";margin-inline-end:6px}
.page-head{margin-bottom:22px}
.page-icon,.card-icon{display:inline-grid;place-items:center;background:var(--icon-bg);background-size:cover;background-position:center;color:var(--icon)}
.page-icon{width:52px;height:52px;margin-bottom:14px;border-radius:min(var(--radius),14px)}
.page-icon img{width:100%;height:100%;object-fit:cover;border-radius:inherit}
h1{font-size:30px;line-height:1.2;letter-spacing:-.015em;margin:0 0 6px}
.lead{margin:0;color:var(--muted);font-size:17px}
.meta{margin:6px 0 0;color:var(--muted);font-size:14px}
h2{font-size:20px;letter-spacing:-.01em;margin:36px 0 12px}
section+section,.grid+section,section+.grid{margin-top:36px}
.section-title{display:flex;align-items:baseline;gap:10px;margin:0 0 12px}
.section-title h2{margin:0}
.section-title h2 a{color:var(--text);text-decoration:none}.section-title h2 a:hover{text-decoration:underline}
.section-title small{color:var(--muted);font-size:13.5px}

.surface{border:var(--card-border);border-radius:var(--radius);background:var(--card);box-shadow:var(--card-shadow)}
.grid{display:grid;grid-template-columns:repeat(var(--cols),minmax(0,1fr));gap:18px;list-style:none;margin:0;padding:0}
.card{display:flex;flex-direction:column;gap:6px;height:100%;padding:22px 22px 20px;text-decoration:none;color:var(--text);transition:transform .12s ease,border-color .12s ease,background .12s ease;overflow:hidden}
.card:hover{transform:translateY(-2px);border-color:var(--action);background:var(--card-hover)}
.card-icon{width:46px;height:46px;margin-bottom:8px;border-radius:min(var(--radius),12px);flex:none}
.card strong{font-size:17.5px;letter-spacing:-.01em}
.card p{margin:0;color:var(--muted);font-size:14.5px;line-height:1.5}
.card .count{margin-top:auto;padding-top:8px;font-size:13px;color:var(--muted)}
.card-image{display:block;width:100%;aspect-ratio:16/9;object-fit:cover}
.style-classic .card-image{border-radius:min(var(--radius),12px);margin-bottom:8px}
.style-visual .card{padding:0;text-align:center;align-items:stretch}
.style-visual .card-visual{display:grid;place-items:center;min-height:128px;background:var(--visual-bg);background-size:cover;background-position:center;color:var(--icon)}
.style-visual .card-visual .card-icon{margin:0;width:56px;height:56px;background:none}
.style-visual .card-text{display:flex;flex-direction:column;gap:6px;flex:1;padding:18px 20px 20px}
.style-compact .card{flex-direction:row;align-items:center;gap:12px;padding:14px 16px}
.style-compact .card-icon{margin:0;width:36px;height:36px}
.style-compact .card-image{width:36px;height:36px;aspect-ratio:1;border-radius:8px}
.style-compact .card strong{flex:1;min-width:0;font-size:15.5px}
.style-compact .card .count{margin:0;padding:0;white-space:nowrap}

.rows{list-style:none;margin:0;padding:0;overflow:hidden}
.rows li+li{border-top:1px solid var(--line)}
.floating .rows li+li{border-top:0}
.rows a{display:flex;align-items:center;gap:12px;padding:15px 18px;color:var(--text);text-decoration:none;font-weight:500}
.rows a:hover{background:var(--card-hover)}
.floating .rows a{border-radius:var(--radius)}
.rows a>span{flex:1;min-width:0}
.rows a svg{flex:none;color:var(--muted)}
.rows p{margin:3px 0 0;color:var(--muted);font-size:14px;font-weight:400}
.rows.columns{display:grid;grid-template-columns:repeat(var(--article-cols,1),minmax(0,1fr))}
.rows.columns li{border-top:0;border-bottom:1px solid var(--line)}
.floating .rows.columns li{border-bottom:0}
.notice{border:1px solid var(--line);border-radius:var(--radius);background:var(--card);padding:12px 16px;margin:0 0 18px;font-size:14.5px}

.contact{display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap;padding:24px 26px}
.contact h2{margin:0 0 4px;font-size:19px}
.contact p{margin:0;color:var(--muted)}
.button{display:inline-block;padding:11px 18px;border-radius:min(var(--radius),10px);background:var(--action);color:var(--on-action);font-weight:600;text-decoration:none;font-size:15px}
.button:hover{filter:brightness(1.06)}
.content-block{padding:34px 30px;border-radius:var(--radius);background:var(--content-bg);background-size:cover;background-position:center;color:var(--content-text)}
.content-block h2{margin:0 0 8px;font-size:24px}
.content-block p{margin:0 0 18px;max-width:640px;white-space:pre-line}
.content-block .button{background:var(--content-text);color:var(--content-on)}
.content-full{border-radius:0;margin-left:calc(50% - 50vw);margin-right:calc(50% - 50vw);padding-left:calc(50vw - 50% + 30px);padding-right:calc(50vw - 50% + 30px)}

.with-nav{display:grid;grid-template-columns:250px minmax(0,1fr);gap:44px;align-items:start}
.side{position:sticky;top:18px;max-height:calc(100vh - 36px);overflow:auto;font-size:14.5px}
.side summary{display:none}
.side ul{list-style:none;margin:0;padding:0}
.side>details>ul>li{margin-bottom:6px}
.side a{display:block;padding:6px 10px;border-radius:8px;color:var(--text);text-decoration:none}
.side a:hover{background:var(--card-hover)}
.side a[aria-current]{background:var(--soft);color:var(--link);font-weight:600}
.side .group{font-weight:600}
.side ul ul{margin:2px 0 6px;padding-inline-start:10px;border-inline-start:1px solid var(--line)}
.side ul ul a{color:var(--muted)}

.article-layout{display:grid;grid-template-columns:minmax(0,760px) 220px;gap:48px;align-items:start}
.article-layout.no-toc{grid-template-columns:minmax(0,760px)}
.toc{position:sticky;top:18px;font-size:13.5px}
.toc strong{display:block;margin-bottom:8px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.toc ol{list-style:none;margin:0;padding:0;border-inline-start:1px solid var(--line)}
.toc a{display:block;padding:4px 12px;color:var(--muted);text-decoration:none}
.toc a:hover{color:var(--text)}
.toc .l3 a{padding-inline-start:24px}
.byline{display:flex;align-items:center;gap:10px;margin:10px 0 0;color:var(--muted);font-size:14px;flex-wrap:wrap}
.avatar{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:50%;background:var(--soft);color:var(--link);font-size:12px;font-weight:700}
.byline a{color:var(--muted)}
.article .rich{font-size:17px;margin-top:26px}
.rich h2{font-size:24px;margin-top:32px}.rich h3{font-size:20px}.rich h4{font-size:18px}
.rich h2,.rich h3{scroll-margin-top:16px}
.rich p{margin:0 0 16px}
.rich img{max-width:100%;height:auto;border-radius:min(var(--radius),10px)}.rich figure{margin:20px 0}
.rich pre{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;overflow:auto;font-size:14px}
.rich code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}
.rich blockquote{margin:16px 0;padding:2px 16px;border-inline-start:4px solid var(--line);color:var(--muted)}
.callout{margin:16px 0;padding:4px 16px;border-radius:10px;border-inline-start:4px solid #3a7bd5;background:rgba(58,123,213,.1)}
.callout-warning{border-color:#c98a00;background:rgba(201,138,0,.12)}
.callout-success{border-color:#1f8a5b;background:rgba(31,138,91,.12)}
.video{position:relative;padding-top:56.25%;margin:16px 0}
.video iframe{position:absolute;inset:0;width:100%;height:100%;border:0;border-radius:10px}
.table{overflow-x:auto;margin:16px 0}
.table table{border-collapse:collapse;min-width:100%}
.table th,.table td{border:1px solid var(--line);padding:8px 10px;text-align:start;vertical-align:top}
.table th{background:var(--card)}
.table td>p:first-child,.table th>p:first-child{margin-top:0}.table td>p:last-child,.table th>p:last-child{margin-bottom:0}
.related{margin-top:40px;padding-top:28px;border-top:1px solid var(--line)}
.related h2{margin:0 0 12px}
.feedback{margin-top:28px;padding:22px 20px;text-align:center}
.feedback p{margin:0}
.feedback .question{margin:0 0 12px;font-weight:600}
.feedback .vote{display:flex;gap:14px;justify-content:center;flex-wrap:wrap}
.feedback .vote button{display:inline-grid;place-items:center;width:52px;height:52px;padding:0;border:1px solid var(--line);border-radius:50%;background:var(--bg);color:var(--muted);cursor:pointer;transition:transform .12s ease,color .12s ease,border-color .12s ease}
.feedback .vote button:hover{transform:scale(1.08);color:var(--link);border-color:var(--action)}
.feedback form:not(.vote){text-align:start;max-width:520px;margin:0 auto}
.feedback label{display:flex;flex-direction:column;gap:6px}
.feedback textarea{font:inherit;font-size:15px;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text)}
.feedback .buttons{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 0}
.feedback .buttons button{font:inherit;font-size:14.5px;font-weight:600;padding:9px 14px;border-radius:9px;border:1px solid var(--line);background:var(--bg);color:var(--text);cursor:pointer}
.feedback .buttons button:first-child{background:var(--action);color:var(--on-action);border-color:transparent}
.results{margin-top:16px}

footer{margin-top:24px;background:var(--foot-bg);color:var(--foot-text);font-size:14px;border-top:1px solid var(--line)}
footer a{color:inherit;text-decoration:none;opacity:.85}footer a:hover{opacity:1;text-decoration:underline}
.foot-inner{max-width:1080px;margin:0 auto;padding:30px 20px;display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center}
.foot-brand{display:inline-flex;align-items:center;gap:10px;font-weight:600;font-family:var(--font-h);font-size:16px}
.foot-brand img{display:block;max-height:32px;max-width:180px}
.foot-links,.socials{display:flex;gap:8px 18px;flex-wrap:wrap;list-style:none;margin:0;padding:0;justify-content:center}
.socials a{display:inline-flex;align-items:center;gap:6px}
.foot-text{margin:0;max-width:640px;white-space:pre-line;opacity:.85}
.powered{font-size:12.5px;opacity:.7}
.foot-classic .foot-inner{flex-direction:row;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;text-align:start}
.foot-classic .foot-main{display:flex;flex-direction:column;gap:12px;max-width:420px}
.foot-classic .foot-links,.foot-classic .socials{justify-content:flex-start}
.foot-classic .foot-end,.foot-multilevel .foot-end{flex-basis:100%;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-top:16px;border-top:1px solid var(--foot-line)}
.foot-multilevel .foot-inner{align-items:stretch;text-align:start}
.foot-multilevel .foot-top{display:flex;justify-content:space-between;gap:30px;flex-wrap:wrap}
.foot-groups{display:flex;gap:44px;flex-wrap:wrap}
.foot-groups strong{display:block;margin-bottom:8px;font-size:12.5px;letter-spacing:.05em;text-transform:uppercase;opacity:.7}
.foot-groups ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.preview a,.preview button,.preview input,.preview textarea,.preview summary{pointer-events:none}

@media (max-width:900px){.grid{grid-template-columns:repeat(min(var(--cols),2),minmax(0,1fr))}.article-layout{grid-template-columns:minmax(0,1fr)}.toc{display:none}.with-nav{grid-template-columns:minmax(0,1fr);gap:18px}.side{position:static;max-height:none;border:1px solid var(--line);border-radius:var(--radius);background:var(--card);padding:6px 12px}.side summary{display:block;cursor:pointer;font-weight:600;padding:6px 0}.rows.columns{grid-template-columns:minmax(0,1fr)}}
@media (max-width:640px){.grid{grid-template-columns:minmax(0,1fr)}.hero-home{min-height:min(var(--hero-h),320px)}.hero-line,h1{font-size:25px}.search input{height:50px}.card{padding:18px}.rows a{padding:13px 14px}.content-block{padding:26px 20px}}
`;

const LATIN = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT = "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";
/** Where the font files are served: Relay's own address, on every host that serves a help center. */
export const FONT_PATH = "/help-fonts/";
/** The @font-face rules for the fonts a theme uses (none for the system font). */
function fontFaces(ids: FontId[]) {
  return [...new Set(ids)]
    .filter((id) => id !== "system")
    .flatMap((id) =>
      [400, 700].flatMap((weight) =>
        (
          [
            ["latin-ext", LATIN_EXT],
            ["latin", LATIN],
          ] as const
        ).map(
          ([subset, range]) =>
            `@font-face{font-family:${JSON.stringify(FONTS[id].name)};font-style:normal;font-weight:${weight};font-display:swap;src:url(${FONT_PATH}${id}-${subset}-${weight}.woff2) format("woff2");unicode-range:${range}}`,
        ),
      ),
    )
    .join("");
}

/** The accent as a translucent wash, for the focus ring and current items. */
function wash(hex: string, alpha = 0.14) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${alpha})`;
}
/** A CSS background for a colour, gradient or image. */
function paint(b: Background, fileUrl: (id: string) => string) {
  if (b.type === "color") return b.color;
  if (b.type === "gradient") return `linear-gradient(135deg,${b.colors.join(",")})`;
  // The id is checked on save (letters, digits, - and _), so it can't end the url().
  return `url(${JSON.stringify(fileUrl(b.fileId))}) center/cover no-repeat`;
}

/**
 * The theme as CSS. Text colours follow the page background (a dark one gets light text); the
 * card colour is made from it for contrast; links use the action colour only where it reads
 * well enough on the page, otherwise a shade of it that does.
 */
export function themeCss(theme: HelpTheme, layout: LayoutBlock[] = [], fileUrl: (id: string) => string = (id) => id) {
  const bg = theme.bodyBackground;
  const dark = luminance(bg) < 0.3;
  const text = dark ? "#eef1f3" : "#161a1d";
  const muted = dark ? "#a3adb6" : "#5c6670";
  const line = dark ? shade(bg, 0.14) : shade(bg, -0.09);
  const card = dark ? shade(bg, 0.07) : luminance(bg) > 0.93 ? "#ffffff" : shade(bg, 0.55);
  const cardHover = dark ? shade(bg, 0.11) : shade(card, -0.03);
  const floating = theme.designStyle === "floating";
  const action = theme.actionColor;
  let link = action;
  for (let i = 1; contrast(link, bg) < 4.5 && i <= 10; i++) link = shade(action, dark ? i / 10 : -i / 10);
  const header = theme.headerBackground;
  const content = layout.find((b): b is Extract<LayoutBlock, { type: "content" }> => b.type === "content");
  const footBg = theme.footerBackground ?? (dark ? shade(bg, 0.04) : "#ffffff");
  const footText = theme.footerTextColor ?? (readableOn(footBg) === "#ffffff" ? "#eef1f3" : "#3d464e");
  const featured = layout.find((b): b is Extract<LayoutBlock, { type: "featured" }> => b.type === "featured");
  const vars: Record<string, string> = {
    "--bg": bg,
    "--text": text,
    "--muted": muted,
    "--line": line,
    "--card": floating ? "transparent" : card,
    "--card-hover": floating ? wash(dark ? "#ffffff" : "#000000", 0.05) : cardHover,
    "--card-border": floating ? "0" : `1px solid ${line}`,
    "--card-shadow": floating || dark ? "none" : "0 1px 2px rgba(16,24,32,.05),0 8px 24px -18px rgba(16,24,32,.25)",
    "--action": action,
    "--on-action": readableOn(action),
    "--link": link,
    "--soft": wash(action),
    "--radius": theme.radius + "px",
    "--font-h": FONTS[theme.fontPrimary].stack,
    "--font-b": FONTS[theme.fontSecondary].stack,
    "--hero-bg": paint(theme.heroBackground, fileUrl),
    "--hero-text": theme.heroText,
    "--hero-h": theme.heroHeight + "px",
    "--hero-justify": { top: "flex-start", center: "center", bottom: "flex-end" }[theme.searchPosition],
    "--hero-align": theme.searchAlign === "center" ? "center" : "flex-start",
    "--hero-textalign": theme.searchAlign === "center" ? "center" : "start",
    "--header-bg": header ?? "transparent",
    "--header-text": header ? readableOn(header) : "inherit",
    "--search-w": { short: "420px", medium: "560px", long: "760px" }[theme.searchLength],
    "--search-r": theme.searchRadius + "px",
    "--cols": String(theme.collectionColumns),
    "--article-cols": String(featured?.columns ?? 1),
    "--icon": theme.iconColor,
    "--icon-bg": theme.iconBackground ? paint(theme.iconBackground, fileUrl) : "transparent",
    "--visual-bg": theme.iconBackground ? paint(theme.iconBackground, fileUrl) : wash(theme.iconColor, 0.1),
    "--foot-bg": footBg,
    "--foot-text": footText,
    "--foot-line": wash(readableOn(footBg), 0.15),
    ...(content
      ? {
          "--content-bg": paint(content.background, fileUrl),
          "--content-text": content.textColor,
          "--content-on": readableOn(content.textColor),
        }
      : {}),
  };
  return (
    fontFaces([theme.fontPrimary, theme.fontSecondary]) +
    `:root{${Object.entries(vars)
      .map(([k, v]) => `${k}:${v}`)
      .join(";")}}`
  );
}
