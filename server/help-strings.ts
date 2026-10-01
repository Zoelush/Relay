/**
 * The help center's own words (header, navigation, notices), per language. Content comes from
 * the help center; these are only the page furniture. Unknown languages use their base, then
 * English.
 */
export type HelpStrings = {
  home: string;
  requests: string;
  updated: (date: string) => string;
  articles: (n: number) => string;
  notTranslated: (shown: string) => string;
  contactTitle: string;
  contactBody: string;
  contactLink: string;
  featured: string;
  notFoundTitle: string;
  notFoundBody: string;
  signInTitle: string;
  signInBody: (brand: string) => string;
  signInLink: string;
  language: string;
  empty: string;
  // Phase 07 B2: search and feedback.
  search: string;
  searchPlaceholder: string;
  searchTitle: string;
  results: (n: number, q: string) => string;
  noResults: (q: string) => string;
  helpful: string;
  yes: string;
  no: string;
  thanks: string;
  tellUs: string;
  send: string;
  sendAndTalk: string;
  talkElsewhere: (brand: string) => string;
  talkDefault: (title: string) => string;
};
const en: HelpStrings = {
  home: "Home",
  requests: "Your requests",
  updated: (d) => `Updated ${d}`,
  articles: (n) => (n === 1 ? "1 article" : `${n} articles`),
  notTranslated: (shown) =>
    `This page isn't available in your language yet. It's shown in ${shown}.`,
  contactTitle: "Still need help?",
  contactBody: "Our team is here for you.",
  contactLink: "See your requests",
  featured: "Popular articles",
  notFoundTitle: "Page not found",
  notFoundBody: "This page doesn't exist, or it has moved.",
  signInTitle: "Sign in to continue",
  signInBody: (b) =>
    `This page is for signed-in ${b} customers. Use the help or support link on ${b}'s website or app, or open its chat and choose "Your tickets and requests".`,
  signInLink: "Go to your requests",
  language: "Language",
  empty: "Nothing here yet.",
  search: "Search",
  searchPlaceholder: "Search for answers",
  searchTitle: "Search results",
  results: (n, q) =>
    n === 1 ? `1 result for “${q}”` : `${n} results for “${q}”`,
  noResults: (q) => `No results for “${q}”. Try other words, or contact us.`,
  helpful: "Was this helpful?",
  yes: "Yes",
  no: "No",
  thanks: "Thanks for letting us know.",
  tellUs: "What were you looking for? (optional)",
  send: "Send",
  sendAndTalk: "Send and talk to us",
  talkElsewhere: (b) =>
    `To talk to us, open the chat on ${b}'s website or app, or sign in to see your requests.`,
  talkDefault: (t) => `I read “${t}” and still need help.`,
};
const fr: HelpStrings = {
  home: "Accueil",
  requests: "Vos demandes",
  updated: (d) => `Mis à jour le ${d}`,
  articles: (n) => (n <= 1 ? `${n} article` : `${n} articles`),
  notTranslated: (shown) =>
    `Cette page n'est pas encore disponible dans votre langue. Elle est affichée en ${shown}.`,
  contactTitle: "Besoin d'aide ?",
  contactBody: "Notre équipe est là pour vous.",
  contactLink: "Voir vos demandes",
  featured: "Articles populaires",
  notFoundTitle: "Page introuvable",
  notFoundBody: "Cette page n'existe pas ou a été déplacée.",
  signInTitle: "Connectez-vous pour continuer",
  signInBody: (b) =>
    `Cette page est réservée aux clients ${b} connectés. Utilisez le lien d'aide sur le site ou l'application de ${b}, ou ouvrez sa messagerie et choisissez « Vos tickets et demandes ».`,
  signInLink: "Aller à vos demandes",
  language: "Langue",
  empty: "Rien pour le moment.",
  search: "Rechercher",
  searchPlaceholder: "Rechercher une réponse",
  searchTitle: "Résultats de recherche",
  results: (n, q) =>
    n <= 1 ? `${n} résultat pour « ${q} »` : `${n} résultats pour « ${q} »`,
  noResults: (q) =>
    `Aucun résultat pour « ${q} ». Essayez d'autres mots ou contactez-nous.`,
  helpful: "Cet article vous a-t-il aidé ?",
  yes: "Oui",
  no: "Non",
  thanks: "Merci pour votre retour.",
  tellUs: "Que cherchiez-vous ? (facultatif)",
  send: "Envoyer",
  sendAndTalk: "Envoyer et nous contacter",
  talkElsewhere: (b) =>
    `Pour nous parler, ouvrez la messagerie sur le site ou l'application de ${b}, ou connectez-vous pour voir vos demandes.`,
  talkDefault: (t) => `J'ai lu « ${t} » et j'ai encore besoin d'aide.`,
};
const de: HelpStrings = {
  home: "Startseite",
  requests: "Ihre Anfragen",
  updated: (d) => `Aktualisiert am ${d}`,
  articles: (n) => (n === 1 ? "1 Artikel" : `${n} Artikel`),
  notTranslated: (shown) =>
    `Diese Seite ist noch nicht in Ihrer Sprache verfügbar. Sie wird auf ${shown} angezeigt.`,
  contactTitle: "Brauchen Sie noch Hilfe?",
  contactBody: "Unser Team ist für Sie da.",
  contactLink: "Ihre Anfragen ansehen",
  featured: "Beliebte Artikel",
  notFoundTitle: "Seite nicht gefunden",
  notFoundBody: "Diese Seite existiert nicht oder wurde verschoben.",
  signInTitle: "Melden Sie sich an, um fortzufahren",
  signInBody: (b) =>
    `Diese Seite ist für angemeldete Kunden von ${b}. Nutzen Sie den Hilfe-Link auf der Website oder in der App von ${b} oder öffnen Sie den Chat und wählen Sie „Ihre Tickets und Anfragen“.`,
  signInLink: "Zu Ihren Anfragen",
  language: "Sprache",
  empty: "Noch nichts hier.",
  search: "Suchen",
  searchPlaceholder: "Nach Antworten suchen",
  searchTitle: "Suchergebnisse",
  results: (n, q) =>
    n === 1 ? `1 Ergebnis für „${q}“` : `${n} Ergebnisse für „${q}“`,
  noResults: (q) =>
    `Keine Ergebnisse für „${q}“. Versuchen Sie andere Wörter oder kontaktieren Sie uns.`,
  helpful: "War das hilfreich?",
  yes: "Ja",
  no: "Nein",
  thanks: "Danke für Ihr Feedback.",
  tellUs: "Wonach haben Sie gesucht? (optional)",
  send: "Senden",
  sendAndTalk: "Senden und Kontakt aufnehmen",
  talkElsewhere: (b) =>
    `Um mit uns zu sprechen, öffnen Sie den Chat auf der Website oder in der App von ${b}, oder melden Sie sich an, um Ihre Anfragen zu sehen.`,
  talkDefault: (t) => `Ich habe „${t}“ gelesen und brauche noch Hilfe.`,
};
const es: HelpStrings = {
  home: "Inicio",
  requests: "Tus solicitudes",
  updated: (d) => `Actualizado el ${d}`,
  articles: (n) => (n === 1 ? "1 artículo" : `${n} artículos`),
  notTranslated: (shown) =>
    `Esta página aún no está disponible en tu idioma. Se muestra en ${shown}.`,
  contactTitle: "¿Necesitas más ayuda?",
  contactBody: "Nuestro equipo está aquí para ayudarte.",
  contactLink: "Ver tus solicitudes",
  featured: "Artículos populares",
  notFoundTitle: "Página no encontrada",
  notFoundBody: "Esta página no existe o se ha movido.",
  signInTitle: "Inicia sesión para continuar",
  signInBody: (b) =>
    `Esta página es para clientes de ${b} con sesión iniciada. Usa el enlace de ayuda en el sitio web o la app de ${b}, o abre su chat y elige «Tus tickets y solicitudes».`,
  signInLink: "Ir a tus solicitudes",
  language: "Idioma",
  empty: "Todavía no hay nada aquí.",
  search: "Buscar",
  searchPlaceholder: "Buscar respuestas",
  searchTitle: "Resultados de búsqueda",
  results: (n, q) =>
    n === 1 ? `1 resultado para «${q}»` : `${n} resultados para «${q}»`,
  noResults: (q) =>
    `No hay resultados para «${q}». Prueba con otras palabras o contáctanos.`,
  helpful: "¿Te ha resultado útil?",
  yes: "Sí",
  no: "No",
  thanks: "Gracias por tu opinión.",
  tellUs: "¿Qué estabas buscando? (opcional)",
  send: "Enviar",
  sendAndTalk: "Enviar y hablar con nosotros",
  talkElsewhere: (b) =>
    `Para hablar con nosotros, abre el chat en el sitio web o la app de ${b}, o inicia sesión para ver tus solicitudes.`,
  talkDefault: (t) => `Leí «${t}» y todavía necesito ayuda.`,
};
const ar: HelpStrings = {
  home: "الرئيسية",
  requests: "طلباتك",
  updated: (d) => `آخر تحديث ${d}`,
  articles: (n) => `${n} مقالة`,
  notTranslated: (shown) =>
    `هذه الصفحة غير متاحة بلغتك بعد. تُعرض باللغة ${shown}.`,
  contactTitle: "هل ما زلت بحاجة إلى مساعدة؟",
  contactBody: "فريقنا هنا لمساعدتك.",
  contactLink: "عرض طلباتك",
  featured: "مقالات شائعة",
  notFoundTitle: "الصفحة غير موجودة",
  notFoundBody: "هذه الصفحة غير موجودة أو تم نقلها.",
  signInTitle: "سجّل الدخول للمتابعة",
  signInBody: (b) =>
    `هذه الصفحة مخصصة لعملاء ${b} المسجلين. استخدم رابط المساعدة في موقع ${b} أو تطبيقه، أو افتح المحادثة واختر "تذاكرك وطلباتك".`,
  signInLink: "الانتقال إلى طلباتك",
  language: "اللغة",
  empty: "لا يوجد شيء هنا بعد.",
  search: "بحث",
  searchPlaceholder: "ابحث عن إجابات",
  searchTitle: "نتائج البحث",
  results: (n, q) => `${n} نتيجة لـ "${q}"`,
  noResults: (q) => `لا توجد نتائج لـ "${q}". جرّب كلمات أخرى أو تواصل معنا.`,
  helpful: "هل كان هذا مفيدًا؟",
  yes: "نعم",
  no: "لا",
  thanks: "شكرًا لملاحظاتك.",
  tellUs: "ما الذي كنت تبحث عنه؟ (اختياري)",
  send: "إرسال",
  sendAndTalk: "إرسال والتحدث إلينا",
  talkElsewhere: (b) =>
    `للتحدث إلينا، افتح المحادثة في موقع ${b} أو تطبيقه، أو سجّل الدخول لرؤية طلباتك.`,
  talkDefault: (t) => `قرأت "${t}" وما زلت بحاجة إلى مساعدة.`,
};
const STRINGS: Record<string, HelpStrings> = { en, fr, de, es, ar };

export function helpStrings(locale: string): HelpStrings {
  return STRINGS[locale] ?? STRINGS[locale.split("-")[0]] ?? en;
}
/** Right-to-left scripts. */
export const isRtl = (locale: string) =>
  ["ar", "he", "fa", "ur", "ps", "sd", "ug", "yi", "dv"].includes(
    locale.split("-")[0],
  );
/**
 * A language's name ("Français" in the switcher; "anglais" mid-sentence in French). Names are
 * capitalised only for the switcher, where each stands alone.
 */
export function languageName(
  locale: string,
  inLocale = locale,
  standalone = true,
) {
  try {
    const name = new Intl.DisplayNames([inLocale], { type: "language" }).of(
      locale,
    );
    if (!name) return locale;
    return standalone
      ? name.charAt(0).toLocaleUpperCase(inLocale) + name.slice(1)
      : name;
  } catch {
    return locale;
  }
}
