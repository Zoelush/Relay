import type { Theme } from "./help-centers";

/**
 * The help center's stylesheet. Fixed text, so its CSP hash is stable; each help center's theme
 * is a second, small block of CSS variables. Light and dark follow the visitor's setting.
 */
export const HELP_CSS = `
:root{--bg:#ffffff;--surface:#f6f8f7;--text:#18211d;--muted:#5b6b64;--line:#dfe6e2;--link:var(--accent);color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#121614;--surface:#1b211e;--text:#e8eeeb;--muted:#a3b2ab;--line:#2c3531;--link:var(--accent-dark)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);font-size:17px;line-height:1.6}
a{color:var(--link)}
a:focus-visible{outline:3px solid var(--accent);outline-offset:2px;border-radius:3px}
.skip{position:absolute;left:-999px}.skip:focus{left:16px;top:8px;background:var(--bg);padding:6px 10px;z-index:2}
.top{background:var(--header-bg);color:var(--header-text)}
.top a{color:var(--header-text)}
.top-inner{max-width:1040px;margin:0 auto;padding:18px 16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.brand{font-weight:700;font-size:20px;text-decoration:none;margin-right:auto}
.top nav{display:flex;gap:14px;align-items:center;flex-wrap:wrap;font-size:15px}
.langs{display:flex;gap:8px;flex-wrap:wrap;list-style:none;margin:0;padding:0}
.langs [aria-current]{font-weight:700;text-decoration:none}
.hero{background:var(--header-bg);color:var(--header-text);padding:8px 0 40px}
.hero h1{max-width:1040px;margin:0 auto;padding:0 16px;font-size:32px;line-height:1.25}
main{max-width:1040px;margin:0 auto;padding:24px 16px 56px}
.crumbs ol{display:flex;flex-wrap:wrap;gap:6px;list-style:none;margin:0 0 18px;padding:0;font-size:14px;color:var(--muted)}
.crumbs li+li::before{content:"/";margin-inline-end:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;list-style:none;margin:0;padding:0}
.card{display:block;height:100%;padding:18px;border:1px solid var(--line);border-radius:12px;background:var(--surface);text-decoration:none;color:var(--text)}
.card:hover{border-color:var(--accent)}
.card strong{display:block;font-size:18px;color:var(--link)}
.card p{margin:6px 0 0;color:var(--muted);font-size:15px}
.list{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.list li{border-bottom:1px solid var(--line)}
.list a{display:block;padding:12px 4px;text-decoration:none}
.list a:hover{text-decoration:underline}
section+section{margin-top:32px}
h1{font-size:30px;line-height:1.25;margin:0 0 8px}
h2{font-size:22px;margin:32px 0 10px}
.meta,.lead{color:var(--muted)}
.notice{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:14px 0}
.contact{margin-top:40px;padding:22px;border-radius:12px;background:var(--surface);border:1px solid var(--line)}
.contact h2{margin-top:0}
.article{max-width:740px}
.rich h2{font-size:24px}.rich h3{font-size:20px}.rich h4{font-size:18px}
.rich img{max-width:100%}
.rich pre{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;font-size:14px}
.rich code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}
.rich blockquote{margin:16px 0;padding:2px 16px;border-inline-start:4px solid var(--line);color:var(--muted)}
.callout{margin:16px 0;padding:4px 16px;border-radius:8px;border-inline-start:4px solid #3a7bd5;background:rgba(58,123,213,.1)}
.callout-warning{border-color:#c98a00;background:rgba(201,138,0,.12)}
.callout-success{border-color:#1f8a5b;background:rgba(31,138,91,.12)}
.video{position:relative;padding-top:56.25%;margin:16px 0}
.video iframe{position:absolute;inset:0;width:100%;height:100%;border:0;border-radius:8px}
.table{overflow-x:auto;margin:16px 0}
.table table{border-collapse:collapse;min-width:100%}
.table th,.table td{border:1px solid var(--line);padding:6px 10px;text-align:start;vertical-align:top}
.table th{background:var(--surface)}
.table td>p:first-child,.table th>p:first-child{margin-top:0}.table td>p:last-child,.table th>p:last-child{margin-bottom:0}
footer{border-top:1px solid var(--line);color:var(--muted);font-size:14px}
footer div{max-width:1040px;margin:0 auto;padding:18px 16px}
.search{display:flex;gap:6px;flex:1 1 220px;max-width:420px}
.search input{flex:1;min-width:0;font:inherit;font-size:15px;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}
.search button,.feedback button{font:inherit;font-size:15px;padding:7px 14px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--text);cursor:pointer}
.search button:focus-visible,.feedback button:focus-visible,.search input:focus-visible,.feedback textarea:focus-visible{outline:3px solid var(--accent);outline-offset:1px}
.top .search input{border-color:transparent}
.search-block .search{max-width:620px}
.search-block{margin-bottom:28px}
main>.search{max-width:620px;margin-bottom:12px}
.results{list-style:none;margin:16px 0 0;padding:0}
.results li{padding:14px 0;border-bottom:1px solid var(--line)}
.results a{font-size:18px;font-weight:600}
.results p{margin:4px 0 0;color:var(--muted);font-size:15px}
.feedback{margin-top:36px;padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}
.feedback .vote{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.feedback label{display:flex;flex-direction:column;gap:6px}
.feedback textarea{font:inherit;font-size:15px;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}
.feedback .buttons{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 0}
.feedback p{margin:0}
@media (max-width:600px){body{font-size:16px}.hero h1,h1{font-size:26px}}
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
/** Lightens a colour towards white, for links on a dark background. */
function lighten(hex: string, amount: number) {
  return (
    "#" +
    [1, 3, 5]
      .map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16);
        return Math.round(c + (255 - c) * amount)
          .toString(16)
          .padStart(2, "0");
      })
      .join("")
  );
}

/**
 * The theme as CSS variables. Header text is black or white, whichever reads better on the
 * colour; links use the colour only where it has enough contrast, otherwise a darker text.
 */
export function themeCss(theme: Theme) {
  const accent = theme.primaryColor;
  const l = luminance(accent);
  const onAccent = contrast(l, 1) >= contrast(l, 0) ? "#ffffff" : "#111111";
  const link = contrast(l, 1) >= 4.5 ? accent : "#1d5c45";
  let dark = accent;
  for (
    let a = 0.1;
    contrast(luminance(dark), luminance("#121614")) < 4.5 && a <= 1;
    a += 0.1
  )
    dark = lighten(accent, a);
  const solid = theme.headerStyle === "solid";
  return `:root{--accent:${link};--accent-dark:${dark};--font:${FONTS[theme.font]};--header-bg:${solid ? accent : "var(--surface)"};--header-text:${solid ? onAccent : "var(--text)"}}`;
}
