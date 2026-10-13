/**
 * The new part of an email (phase 12, step E2; docs/OMNICHANNEL_STEP2.md): quoted history and
 * signatures stripped from a reply, so the timeline shows what the customer wrote this time. The
 * full message is kept beside it (`email_messages`). Forwards are kept whole: what was forwarded
 * is the point.
 *
 * Rules, in order (each line-based, on text with Windows line endings normalised):
 * 1. A forward (a "Forwarded message" marker before any reply header, or a subject starting FW:)
 *    is kept whole.
 * 2. The text is cut at the first reply header: "On … wrote:" and its translations (it may wrap
 *    onto a second line), Outlook's "From: … / Sent: …" block (and the rule or "Original Message"
 *    line above it), or Japanese, Chinese and Korean clients' headers.
 * 3. Trailing ">" quoted lines go.
 * 4. A signature after "-- " goes, as do the mobile sign-offs ("Sent from my iPhone", and so on).
 */
const WROTE = [
  /^\s*On\b.{0,400}\bwrote:\s*$/i,
  /^\s*Le\b.{0,400}\ba écrit\s*:\s*$/i,
  /^\s*Am\b.{0,400}\bschrieb\b.{0,150}:\s*$/i,
  /^\s*El\b.{0,400}\bescribió:\s*$/i,
  /^\s*(Em|No dia)\b.{0,400}\bescreveu:\s*$/i,
  /^\s*Il (giorno )?\b.{0,400}\bha scritto:\s*$/i,
  /^\s*Op\b.{0,400}\bschreef\b.{0,150}:\s*$/i,
  /^\s*(Den|På)\b.{0,400}\b(skrev|skreiv)\b.{0,150}:\s*$/i,
  /^\s*W dniu\b.{0,400}\bnapisał(a)?:\s*$/i,
  /^\s*\d{4}年\d{1,2}月\d{1,2}日.{0,300}[:：]\s*$/,
  /^.{0,300}写道[:：]\s*$/,
  /^.{0,300}님이 작성:\s*$/,
  /^.{0,200}\d{4}\s*г\..{0,200}(пишет|написал\(а\)?|написал)?\s*:\s*$/i,
];
const FROM = /^\s*\**(From|De|Von|Van|Da|Od|От|Från|Fra|Lähettäjä|发件人|寄件者|差出人|보낸 사람)\**\s*[:：]/i;
const SENT = /^\s*\**(Sent|Date|Envoyé|Gesendet|Datum|Verzonden|Inviato|Data|Enviado|Fecha|Отправлено|Дата|Skickat|Sendt|Lähetetty|发送时间|日期|送信日時|日付|보낸 날짜)\**\s*[:：]/i;
const RULES = /^\s*(-{2,}\s*(Original Message|Ursprüngliche Nachricht|Message d'origine|Mensaje original|Messaggio originale|Oorspronkelijk bericht|Исходное сообщение|Mensagem original|Ursprungligt meddelande)\s*-{2,}|_{10,}|-{10,})\s*$/i;
const FORWARD = /^\s*(-{2,}\s*(Forwarded message|Forwarded Message|Weitergeleitete Nachricht|Message transféré|Mensaje reenviado|Messaggio inoltrato|Doorgestuurd bericht|Пересылаемое сообщение|Mensagem encaminhada)\s*-{2,}|Begin forwarded message:)\s*$/i;
const FORWARD_SUBJECT = /^\s*(fwd?|wg|tr|rv|enc|vs|i|fw)\s*[:：]/i;
const SIGN_OFFS = [
  /^\s*Sent from my (iPhone|iPad|Android|Galaxy|Samsung|Pixel|BlackBerry|mobile device|phone)\b.*$/i,
  /^\s*Sent from Samsung Mobile\b.*$/i,
  /^\s*Sent from (Yahoo Mail|Mail for Windows|Outlook|my Huawei)\b.*$/i,
  /^\s*Get Outlook for (iOS|Android)\s*$/i,
  /^\s*(Envoyé de mon|Envoyé depuis mon) (iPhone|iPad|Android|smartphone)\b.*$/i,
  /^\s*Von meinem (iPhone|iPad|Android|Smartphone) gesendet\s*$/i,
  /^\s*Enviado desde mi (iPhone|iPad|Android|móvil)\b.*$/i,
  /^\s*Inviato da (iPhone|iPad|Android)\b.*$/i,
  /^\s*Verzonden vanaf mijn (iPhone|iPad|Android)\b.*$/i,
  /^\s*Отправлено с (iPhone|iPad|Android)\b.*$/i,
  /^\s*iPhoneから送信\s*$/,
];

export type Stripped = { text: string; stripped: boolean; forwarded: boolean };

export function stripReply(input: string, subject = ""): Stripped {
  const text = input.replace(/\r\n?/g, "\n").replace(/ /g, " ");
  const lines = text.split("\n");
  let cut = lines.length;
  // A forward is kept whole (its forwarded message is what the customer sends us).
  const forwardAt = lines.findIndex((l) => FORWARD.test(l));
  const forwarded = forwardAt >= 0 || FORWARD_SUBJECT.test(subject);
  for (let i = 0; i < lines.length && !forwarded; i++) {
    const line = lines[i];
    const joined = i + 1 < lines.length ? `${line} ${lines[i + 1]}` : line;
    if (WROTE.some((r) => r.test(line))) {
      cut = i;
      break;
    }
    // "On Mon, 12 Oct 2026 at 09:41, Jane <jane@\nexample.com> wrote:" wraps onto a second line.
    if (/^\s*(On|Le|Am|El|Em|Il|Op|Den|På|W dniu)\b/i.test(line) && WROTE.some((r) => r.test(joined))) {
      cut = i;
      break;
    }
    if (RULES.test(line) && lines.slice(i + 1, i + 4).some((l) => FROM.test(l) || /Original Message|Message d'origine/i.test(line))) {
      cut = i;
      break;
    }
    if (FROM.test(line) && lines.slice(i + 1, i + 6).some((l) => SENT.test(l))) {
      cut = i;
      break;
    }
  }
  let kept = lines.slice(0, cut);
  // Trailing quoted lines (and blanks between them).
  if (!forwarded) {
    let end = kept.length;
    while (end > 0 && (/^\s*>/.test(kept[end - 1]) || !kept[end - 1].trim())) end--;
    if (end < kept.length && kept.slice(end).some((l) => /^\s*>/.test(l))) kept = kept.slice(0, end);
  }
  // A signature after the "-- " delimiter, within the last 25 lines.
  const delimiter = kept.findLastIndex((l) => l === "-- " || l === "--");
  if (delimiter > 0 && kept.length - delimiter <= 25) kept = kept.slice(0, delimiter);
  // Mobile sign-offs at the end.
  let end = kept.length;
  while (end > 0 && (!kept[end - 1].trim() || SIGN_OFFS.some((r) => r.test(kept[end - 1])))) end--;
  kept = kept.slice(0, end);
  const out = kept
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const whole = text.trim().replace(/\n{3,}/g, "\n\n");
  return { text: out || whole, stripped: !!out && out !== whole, forwarded };
}

/** A subject without its Re:/Fwd: prefixes (in many languages), for threading by subject. */
export function baseSubject(subject: string) {
  let s = subject.trim();
  for (let i = 0; i < 10; i++) {
    const next = s.replace(/^\s*(re|aw|sv|vs|antw|odp|ynt|res|r|fwd?|wg|tr|rv|enc|i|回复|答复|回覆|转发|轉寄|Ответ|Отв|Пересл)\s*(\[\d+\])?\s*[:：]\s*/i, "").replace(/^\s*\[[^\]]{1,40}\]\s*/, "");
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}
