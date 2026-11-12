import type { Theme } from "./help-centers";

/**
 * The help center's stylesheet (redesigned in November 2026; docs/HELP_CENTER_DESIGN.md). Fixed
 * text, so its CSP hash is stable; each help center's theme is a second, small block of CSS
 * variables. Light and dark follow the visitor's setting.
 *
 * The page: a header with the logo, a hero in the brand colour with the welcome line and one
 * large search box, then the content in a 1040px column: collection cards with icons, article
 * rows with chevrons, a related-articles card, three reactions under an article, and a footer.
 */
export const HELP_CSS = `
:root{--bg:#ffffff;--surface:#f6f7f8;--card:#ffffff;--text:#161a1d;--muted:#5c6670;--line:#e3e7ea;--shadow:0 1px 2px rgba(16,24,32,.06),0 8px 24px -16px rgba(16,24,32,.25);--link:var(--accent);--icon-bg:var(--accent-soft);color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#111416;--surface:#181c1f;--card:#1d2226;--text:#e9edef;--muted:#9aa6b0;--line:#2a3136;--shadow:0 1px 2px rgba(0,0,0,.4),0 12px 32px -16px rgba(0,0,0,.7);--link:var(--accent-dark);--icon-bg:rgba(255,255,255,.07)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--surface);color:var(--text);font-family:var(--font);font-size:16px;line-height:1.6}
a{color:var(--link)}
a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid var(--accent);outline-offset:2px;border-radius:4px}
.skip{position:absolute;left:-999px}.skip:focus{left:16px;top:8px;background:var(--bg);padding:6px 10px;z-index:2}
.wrap{max-width:1040px;margin:0 auto;padding:0 20px}
.top{background:var(--hero-bg);color:var(--hero-text)}
.top a{color:inherit}
.top-inner{display:flex;gap:18px;align-items:center;flex-wrap:wrap;padding-top:22px}
.brand{display:inline-flex;align-items:center;gap:10px;font-weight:700;font-size:21px;letter-spacing:-.01em;text-decoration:none;margin-right:auto}
.brand img{display:block;max-height:40px;max-width:220px}
.top nav{display:flex;gap:16px;align-items:center;flex-wrap:wrap;font-size:14.5px}
.top nav a{text-decoration:none;opacity:.88}.top nav a:hover{opacity:1;text-decoration:underline}
.langs{display:flex;gap:10px;flex-wrap:wrap;list-style:none;margin:0;padding:0}
.langs [aria-current]{font-weight:700;opacity:1}
.hero{background:var(--hero-bg);color:var(--hero-text);padding:22px 0 34px}
.hero-home{padding:36px 0 56px}
.hero h1{margin:0 0 20px;font-size:30px;line-height:1.2;letter-spacing:-.015em;font-weight:700}
.search{position:relative;display:flex;align-items:center;gap:8px;max-width:760px}
.search-icon{position:absolute;left:16px;top:50%;transform:translateY(-50%);opacity:.55;pointer-events:none;color:var(--text)}
.search input{flex:1;min-width:0;height:54px;padding:0 16px 0 46px;font:inherit;font-size:16px;border:1px solid transparent;border-radius:12px;background:var(--bg);color:var(--text);box-shadow:var(--shadow)}
.search input::placeholder{color:var(--muted)}
.search input:focus{border-color:var(--accent);outline:none;box-shadow:0 0 0 4px var(--accent-soft)}
.search button{position:absolute;right:7px;top:7px;height:40px;padding:0 16px;font:inherit;font-size:14.5px;font-weight:600;border:0;border-radius:9px;background:var(--accent);color:var(--on-accent);cursor:pointer}
.top .search{max-width:360px}
.top .search input{height:42px;padding-left:40px;font-size:14.5px;box-shadow:none;border-color:var(--line)}
.top .search .search-icon{left:13px}
.top .search button{top:4px;right:4px;height:34px;padding:0 12px}
.hero .search-icon,.hero .search input{color:var(--text)}
main{max-width:1040px;margin:0 auto;padding:28px 20px 64px}
.crumbs ol{display:flex;flex-wrap:wrap;gap:6px;list-style:none;margin:0 0 22px;padding:0;font-size:13.5px;color:var(--muted)}
.crumbs a{color:var(--muted);text-decoration:none}.crumbs a:hover{text-decoration:underline;color:var(--text)}
.crumbs li+li::before{content:"›";margin-inline-end:6px}
.page-head{margin-bottom:22px}
.page-icon{display:inline-grid;place-items:center;width:52px;height:52px;margin-bottom:14px;border-radius:14px;background:var(--icon-bg);color:var(--link)}
h1{font-size:30px;line-height:1.2;letter-spacing:-.015em;margin:0 0 6px}
.lead{margin:0;color:var(--muted);font-size:17px}
.meta{margin:6px 0 0;color:var(--muted);font-size:14px}
h2{font-size:20px;letter-spacing:-.01em;margin:36px 0 12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:18px;list-style:none;margin:0;padding:0}
.card{display:flex;flex-direction:column;gap:6px;height:100%;padding:22px 22px 20px;border:1px solid var(--line);border-radius:16px;background:var(--card);box-shadow:var(--shadow);text-decoration:none;color:var(--text);transition:transform .12s ease,border-color .12s ease}
.card:hover{transform:translateY(-2px);border-color:var(--accent)}
.card-icon{display:inline-grid;place-items:center;width:46px;height:46px;margin-bottom:8px;border-radius:12px;background:var(--icon-bg);color:var(--link)}
.card strong{font-size:17.5px;letter-spacing:-.01em}
.card p{margin:0;color:var(--muted);font-size:14.5px;line-height:1.5}
.card .count{margin-top:auto;padding-top:8px;font-size:13px;color:var(--muted)}
.rows{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:14px;background:var(--card);box-shadow:var(--shadow);overflow:hidden}
.rows li+li{border-top:1px solid var(--line)}
.rows a{display:flex;align-items:center;gap:12px;padding:15px 18px;color:var(--text);text-decoration:none;font-weight:500}
.rows a:hover{background:var(--surface)}
.rows a span{flex:1;min-width:0}
.rows a svg{flex:none;color:var(--muted)}
.rows p{margin:3px 0 0;color:var(--muted);font-size:14px;font-weight:400}
.section-title{display:flex;align-items:baseline;gap:10px;margin:32px 0 12px}
.section-title h2{margin:0}
.section-title h2 a{color:var(--text);text-decoration:none}.section-title h2 a:hover{text-decoration:underline}
.section-title small{color:var(--muted);font-size:13.5px}
.notice{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin:0 0 18px;font-size:14.5px}
.contact{display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap;margin-top:40px;padding:24px 26px;border-radius:16px;background:var(--card);border:1px solid var(--line);box-shadow:var(--shadow)}
.contact h2{margin:0 0 4px;font-size:19px}
.contact p{margin:0;color:var(--muted)}
.button{display:inline-block;padding:11px 18px;border-radius:10px;background:var(--accent);color:var(--on-accent);font-weight:600;text-decoration:none;font-size:15px}
.button:hover{filter:brightness(1.05)}
.article{max-width:760px}
.article .rich{font-size:17px}
.rich h2{font-size:24px;margin-top:32px}.rich h3{font-size:20px}.rich h4{font-size:18px}
.rich p{margin:0 0 16px}
.rich img{max-width:100%;height:auto;border-radius:10px}.rich figure{margin:20px 0}
.rich pre{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px;overflow:auto;font-size:14px}
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
.table th{background:var(--surface)}
.table td>p:first-child,.table th>p:first-child{margin-top:0}.table td>p:last-child,.table th>p:last-child{margin-bottom:0}
.related{margin-top:40px;padding-top:28px;border-top:1px solid var(--line)}
.related h2{margin:0 0 12px}
.feedback{margin-top:28px;padding:22px 20px;border-radius:14px;background:var(--card);border:1px solid var(--line);text-align:center}
.feedback p{margin:0}
.feedback .question{margin:0 0 12px;font-weight:600}
.feedback .vote{display:flex;gap:14px;justify-content:center;flex-wrap:wrap}
.feedback .vote button{display:inline-grid;place-items:center;width:52px;height:52px;padding:0;border:1px solid var(--line);border-radius:50%;background:var(--bg);color:var(--muted);cursor:pointer;transition:transform .12s ease,color .12s ease,border-color .12s ease}
.feedback .vote button:hover{transform:scale(1.08);color:var(--link);border-color:var(--accent)}
.feedback form:not(.vote){text-align:start;max-width:520px;margin:0 auto}
.feedback label{display:flex;flex-direction:column;gap:6px}
.feedback textarea{font:inherit;font-size:15px;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text)}
.feedback .buttons{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 0}
.feedback .buttons button{font:inherit;font-size:14.5px;font-weight:600;padding:9px 14px;border-radius:9px;border:1px solid var(--line);background:var(--bg);color:var(--text);cursor:pointer}
.feedback .buttons button:first-child{background:var(--accent);color:var(--on-accent);border-color:transparent}
.results{list-style:none;margin:16px 0 0;padding:0}
footer{margin-top:24px;border-top:1px solid var(--line);color:var(--muted);font-size:14px;background:var(--bg)}
.foot-inner{max-width:1040px;margin:0 auto;padding:26px 20px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.foot-brand{display:inline-flex;align-items:center;gap:10px;font-weight:600;color:var(--text)}
.foot-brand img{display:block;max-height:28px;max-width:160px}
footer nav{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
footer a{color:var(--muted);text-decoration:none}footer a:hover{color:var(--text);text-decoration:underline}
@media (max-width:640px){.hero-home{padding:26px 0 36px}.hero h1,h1{font-size:25px}.search input{height:50px}.card{padding:18px}.rows a{padding:13px 14px}}
`;

const FONTS: Record<Theme["font"], string> = {
  system:
    'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif',
  serif: 'Georgia,"Iowan Old Style","Times New Roman",serif',
  rounded:
    'ui-rounded,"SF Pro Rounded",system-ui,-apple-system,"Segoe UI",sans-serif',
};
/** Relative luminance (WCAG) of a #rrggbb colour. */
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: number, b: number) =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
/** A colour moved towards white (amount > 0) or black (amount < 0). */
function shade(hex: string, amount: number) {
  return (
    "#" +
    [1, 3, 5]
      .map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16);
        const to = amount >= 0 ? 255 : 0;
        return Math.round(c + (to - c) * Math.abs(amount))
          .toString(16)
          .padStart(2, "0");
      })
      .join("")
  );
}
/** The accent as a translucent wash, for icon tiles and the focus ring. */
function wash(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},.14)`;
}

/**
 * The theme as CSS variables. Header text is black or white, whichever reads better on the
 * colour; links use the colour only where it has enough contrast, otherwise a darker text. The
 * hero is the colour deepening to a darker shade (a solid header), or the page's surface.
 */
export function themeCss(theme: Theme) {
  const accent = theme.primaryColor;
  const l = luminance(accent);
  const onAccent = contrast(l, 1) >= contrast(l, 0) ? "#ffffff" : "#111111";
  const link = contrast(l, 1) >= 4.5 ? accent : "#1d5c45";
  let dark = accent;
  for (
    let a = 0.1;
    contrast(luminance(dark), luminance("#111416")) < 4.5 && a <= 1;
    a += 0.1
  )
    dark = shade(accent, a);
  const solid = theme.headerStyle === "solid";
  const heroBg = solid
    ? `linear-gradient(135deg,${accent} 0%,${shade(accent, -0.35)} 100%)`
    : "var(--surface)";
  return `:root{--accent:${link};--accent-dark:${dark};--accent-soft:${wash(accent)};--on-accent:${onAccent};--font:${FONTS[theme.font]};--header-bg:${solid ? accent : "var(--surface)"};--header-text:${solid ? onAccent : "var(--text)"};--hero-bg:${heroBg};--hero-text:${solid ? onAccent : "var(--text)"}}`;
}
