/**
 * The evaluation's knowledge (phase 08, C1; docs/AI_STEP10.md): a fictional bike shop, Fernhill
 * Cycles, fixed so scores only change when Zoe does. Each article has its questions (with the
 * fact a correct answer must contain), and four are also in six other languages.
 */
export type EvalArticle = {
  id: string;
  title: string;
  text: string;
  /** Questions this article answers, and a phrase the answer must contain. */
  questions: [question: string, fact: string][];
  /** The same article in other languages, each with one question and its fact. */
  translations?: Record<string, { title: string; text: string; question: string; fact: string }>;
};

export const ARTICLES: EvalArticle[] = [
  {
    id: "delivery-times",
    title: "Delivery times",
    text: "Standard delivery takes three to five working days. Express delivery arrives the next working day when you order before 2pm. We deliver to the UK and the EU.",
    questions: [
      ["How long does standard delivery take?", "three to five working days"],
      ["Can express delivery arrive the next working day?", "next working day"],
      ["Do you deliver to the EU?", "UK and the EU"],
    ],
    translations: {
      fr: {
        title: "Délais de livraison",
        text: "La livraison standard prend trois à cinq jours ouvrés. La livraison express arrive le jour ouvré suivant si vous commandez avant 14 h.",
        question: "Combien de jours prend la livraison standard ?",
        fact: "trois à cinq jours",
      },
      es: {
        title: "Plazos de entrega",
        text: "La entrega estándar tarda de tres a cinco días laborables. La entrega exprés llega el siguiente día laborable si pides antes de las 14:00.",
        question: "¿Cuántos días tarda la entrega estándar?",
        fact: "tres a cinco días",
      },
      de: {
        title: "Lieferzeiten",
        text: "Die Standardlieferung dauert drei bis fünf Werktage. Die Expresslieferung kommt am nächsten Werktag, wenn Sie vor 14 Uhr bestellen.",
        question: "Wie lange dauert die Standardlieferung?",
        fact: "drei bis fünf Werktage",
      },
      pt: {
        title: "Prazos de entrega",
        text: "A entrega normal demora três a cinco dias úteis. A entrega expresso chega no dia útil seguinte se encomendar antes das 14h.",
        question: "Quantos dias demora a entrega normal?",
        fact: "três a cinco dias úteis",
      },
      it: {
        title: "Tempi di consegna",
        text: "La consegna standard richiede da tre a cinque giorni lavorativi. La consegna espressa arriva il giorno lavorativo successivo se ordini prima delle 14.",
        question: "Quanti giorni richiede la consegna standard?",
        fact: "tre a cinque giorni lavorativi",
      },
      nl: {
        title: "Levertijden",
        text: "Standaardlevering duurt drie tot vijf werkdagen. Expreslevering komt de volgende werkdag als je voor 14 uur bestelt.",
        question: "Hoeveel werkdagen duurt standaardlevering?",
        fact: "drie tot vijf werkdagen",
      },
    },
  },
  {
    id: "delivery-costs",
    title: "Delivery costs",
    text: "Standard delivery is free on orders over 50 pounds. Below 50 pounds, standard delivery costs 4.95 pounds. Express delivery costs 9.95 pounds.",
    questions: [
      ["Is standard delivery free on bigger orders?", "free on orders over 50 pounds"],
      ["How much does express delivery cost?", "9.95"],
      ["What does standard delivery cost below 50 pounds?", "4.95"],
    ],
  },
  {
    id: "returns-bikes",
    title: "Returning a bike",
    text: "You can return an unused bike within 30 days for a full refund. Bikes must be returned in their original box. We collect returned bikes for free.",
    questions: [
      ["Can I return an unused bike?", "30 days"],
      ["Do bikes need their original box to be returned?", "original box"],
      ["Do you collect returned bikes?", "collect returned bikes for free"],
    ],
    translations: {
      fr: {
        title: "Retourner un vélo",
        text: "Vous pouvez retourner un vélo non utilisé sous 30 jours pour un remboursement complet. Les vélos doivent être retournés dans leur carton d'origine.",
        question: "Puis-je retourner un vélo non utilisé ?",
        fact: "30 jours",
      },
      es: {
        title: "Devolver una bicicleta",
        text: "Puedes devolver una bicicleta sin usar en un plazo de 30 días para un reembolso completo. Las bicicletas deben devolverse en su caja original.",
        question: "¿Puedo devolver una bicicleta sin usar?",
        fact: "30 días",
      },
      de: {
        title: "Ein Fahrrad zurückgeben",
        text: "Sie können ein unbenutztes Fahrrad innerhalb von 30 Tagen gegen volle Erstattung zurückgeben. Fahrräder müssen im Originalkarton zurückgegeben werden.",
        question: "Kann ich ein unbenutztes Fahrrad zurückgeben?",
        fact: "30 Tagen",
      },
      pt: {
        title: "Devolver uma bicicleta",
        text: "Pode devolver uma bicicleta não usada no prazo de 30 dias para um reembolso total. As bicicletas devem ser devolvidas na caixa original.",
        question: "Posso devolver uma bicicleta não usada?",
        fact: "30 dias",
      },
      it: {
        title: "Restituire una bici",
        text: "Puoi restituire una bici non usata entro 30 giorni per un rimborso completo. Le bici devono essere restituite nella scatola originale.",
        question: "Posso restituire una bici non usata?",
        fact: "30 giorni",
      },
      nl: {
        title: "Een fiets retourneren",
        text: "Je kunt een ongebruikte fiets binnen 30 dagen retourneren voor een volledige terugbetaling. Fietsen moeten in de originele doos worden geretourneerd.",
        question: "Kan ik een ongebruikte fiets retourneren?",
        fact: "30 dagen",
      },
    },
  },
  {
    id: "returns-clothing",
    title: "Returning clothing",
    text: "Clothing can be returned within 60 days if it still has its tags. Return clothing by post using the prepaid label in your parcel.",
    questions: [
      ["How long do I have to return clothing?", "60 days"],
      ["Is there a prepaid label for returning clothing?", "prepaid label"],
      ["Can clothing be returned without its tags?", "still has its tags"],
    ],
  },
  {
    id: "refunds",
    title: "Refunds",
    text: "Refunds reach your original payment method within five working days of us receiving your return. We email you when the refund is issued.",
    questions: [
      ["How long do refunds take to reach me?", "five working days"],
      ["Will you email me when my refund is issued?", "email you when the refund is issued"],
      ["Which payment method does my refund go to?", "original payment method"],
    ],
    translations: {
      fr: {
        title: "Remboursements",
        text: "Les remboursements arrivent sur votre moyen de paiement d'origine sous cinq jours ouvrés après réception de votre retour.",
        question: "Quand les remboursements arrivent-ils sur mon moyen de paiement ?",
        fact: "cinq jours ouvrés",
      },
      es: {
        title: "Reembolsos",
        text: "Los reembolsos llegan a tu método de pago original en cinco días laborables desde que recibimos tu devolución.",
        question: "¿Cuándo llegan los reembolsos a mi método de pago?",
        fact: "cinco días laborables",
      },
      de: {
        title: "Erstattungen",
        text: "Erstattungen erreichen Ihre ursprüngliche Zahlungsmethode innerhalb von fünf Werktagen nach Eingang Ihrer Rücksendung.",
        question: "Wann erreichen Erstattungen meine Zahlungsmethode?",
        fact: "fünf Werktagen",
      },
      pt: {
        title: "Reembolsos",
        text: "Os reembolsos chegam ao seu método de pagamento original em cinco dias úteis após recebermos a sua devolução.",
        question: "Quando chegam os reembolsos ao meu método de pagamento?",
        fact: "cinco dias úteis",
      },
      it: {
        title: "Rimborsi",
        text: "I rimborsi arrivano sul tuo metodo di pagamento originale entro cinque giorni lavorativi dalla ricezione del reso.",
        question: "Quando arrivano i rimborsi sul mio metodo di pagamento?",
        fact: "cinque giorni lavorativi",
      },
      nl: {
        title: "Terugbetalingen",
        text: "Terugbetalingen komen binnen vijf werkdagen na ontvangst van je retour op je oorspronkelijke betaalmethode.",
        question: "Wanneer komen terugbetalingen op mijn betaalmethode?",
        fact: "vijf werkdagen",
      },
    },
  },
  {
    id: "warranty",
    title: "Bike warranty",
    text: "Every bike frame has a lifetime warranty. Components such as gears and brakes are covered for two years.",
    questions: [
      ["How long is the frame warranty?", "lifetime warranty"],
      ["Are gears and brakes covered by the warranty?", "two years"],
      ["Does every bike frame have a warranty?", "lifetime"],
    ],
    translations: {
      fr: {
        title: "Garantie vélo",
        text: "Chaque cadre de vélo a une garantie à vie. Les composants comme les freins sont couverts pendant deux ans.",
        question: "Quelle garantie pour le cadre de vélo ?",
        fact: "garantie à vie",
      },
      es: {
        title: "Garantía de la bicicleta",
        text: "Cada cuadro de bicicleta tiene una garantía de por vida. Los componentes como los frenos están cubiertos durante dos años.",
        question: "¿Qué garantía tiene el cuadro de bicicleta?",
        fact: "garantía de por vida",
      },
      de: {
        title: "Fahrradgarantie",
        text: "Jeder Fahrradrahmen hat eine lebenslange Garantie. Komponenten wie Bremsen sind zwei Jahre abgedeckt.",
        question: "Welche Garantie hat der Fahrradrahmen?",
        fact: "lebenslange Garantie",
      },
      pt: {
        title: "Garantia da bicicleta",
        text: "Cada quadro de bicicleta tem uma garantia vitalícia. Componentes como os travões estão cobertos durante dois anos.",
        question: "Que garantia tem o quadro da bicicleta?",
        fact: "garantia vitalícia",
      },
      it: {
        title: "Garanzia della bici",
        text: "Ogni telaio di bici ha una garanzia a vita. I componenti come i freni sono coperti per due anni.",
        question: "Che garanzia ha il telaio della bici?",
        fact: "garanzia a vita",
      },
      nl: {
        title: "Fietsgarantie",
        text: "Elk fietsframe heeft levenslange garantie. Onderdelen zoals remmen vallen twee jaar onder de garantie.",
        question: "Welke garantie heeft het fietsframe?",
        fact: "levenslange garantie",
      },
    },
  },
  {
    id: "sizing",
    title: "Choosing a frame size",
    text: "Measure your inside leg and use our size chart to choose a frame size. Riders between two sizes should choose the smaller frame.",
    questions: [
      ["How do I choose a frame size?", "size chart"],
      ["I'm between two frame sizes, which should I choose?", "smaller frame"],
      ["What should I measure to choose a frame size?", "inside leg"],
    ],
  },
  {
    id: "first-service",
    title: "Free first service",
    text: "Every new bike gets a free first service within three months of purchase. Book the service at any of our workshops.",
    questions: [
      ["Is the first service free?", "free first service"],
      ["When should the first service happen?", "within three months"],
      ["Where can I book the service?", "workshops"],
    ],
  },
  {
    id: "workshop-hours",
    title: "Workshop opening hours",
    text: "Our workshops open from 9am to 6pm, Monday to Saturday. Workshops are closed on Sundays and public holidays.",
    questions: [
      ["What are the workshop opening hours?", "9am to 6pm"],
      ["Are workshops open on Sundays?", "closed on Sundays"],
      ["Do workshops open on Saturday?", "Monday to Saturday"],
    ],
  },
  {
    id: "ebike-battery",
    title: "E-bike batteries",
    text: "An e-bike battery lasts about 60 to 100 miles on a full charge. A full charge takes four to six hours.",
    questions: [
      ["How many miles does an e-bike battery last?", "60 to 100 miles"],
      ["How long does a full charge take?", "four to six hours"],
      ["How far does a full battery charge last?", "60 to 100 miles"],
    ],
  },
  {
    id: "instalments",
    title: "Paying in instalments",
    text: "You can spread the cost of a bike over 12 months with zero interest. Instalments are available on orders over 500 pounds.",
    questions: [
      ["Can I spread the cost of a bike?", "12 months"],
      ["Is there interest on instalments?", "zero interest"],
      ["What is the minimum order for instalments?", "500 pounds"],
    ],
  },
  {
    id: "payment-methods",
    title: "Payment methods",
    text: "We accept Visa, Mastercard, American Express and PayPal. We do not accept cash on delivery.",
    questions: [
      ["Do you accept PayPal?", "PayPal"],
      ["Can I pay cash on delivery?", "do not accept cash on delivery"],
      ["Do you accept Mastercard?", "Mastercard"],
    ],
  },
  {
    id: "order-changes",
    title: "Changing an order",
    text: "You can change or cancel an order within one hour of placing it. After that, the order is packed and can only be returned.",
    questions: [
      ["Can I cancel an order?", "within one hour"],
      ["How long do I have to change an order?", "one hour"],
      ["Can I change an order after it is packed?", "can only be returned"],
    ],
  },
  {
    id: "tracking",
    title: "Tracking your parcel",
    text: "Every parcel has a tracking link in your dispatch email. Tracking updates appear within a few hours of dispatch.",
    questions: [
      ["How do I track my parcel?", "tracking link"],
      ["Where is the parcel tracking link?", "dispatch email"],
      ["When do tracking updates appear?", "few hours"],
    ],
  },
  {
    id: "assembly",
    title: "Bike assembly",
    text: "Bikes arrive 90 percent assembled. You only need to fit the handlebars and pedals, which takes about 15 minutes.",
    questions: [
      ["Do bikes arrive assembled?", "90 percent"],
      ["What do I need to fit when my bike arrives?", "handlebars and pedals"],
      ["How long does it take to fit the handlebars and pedals?", "15 minutes"],
    ],
  },
  {
    id: "gift-cards",
    title: "Gift cards",
    text: "Gift cards are available from 10 to 500 pounds. Gift cards are valid for two years and can be used online or in store.",
    questions: [
      ["How long is a gift card valid?", "two years"],
      ["Can gift cards be used in store?", "online or in store"],
      ["Which gift card amounts are available?", "10 to 500 pounds"],
    ],
  },
  {
    id: "student-discount",
    title: "Student discount",
    text: "Students get 10 percent off full-price items. Verify your student status at checkout to apply the student discount.",
    questions: [
      ["Is there a student discount?", "10 percent"],
      ["How do I apply the student discount?", "student status"],
      ["Does the student discount apply to full-price items?", "full-price items"],
    ],
  },
  {
    id: "price-match",
    title: "Price match",
    text: "We match the price of any UK retailer selling the same item in stock. Contact us before you order to request a price match.",
    questions: [
      ["Do you price match?", "any UK retailer"],
      ["How do I request a price match?", "before you order"],
      ["Do you match another retailer's price?", "UK retailer"],
    ],
  },
  {
    id: "account",
    title: "Your account",
    text: "You can reset your password from the sign-in page. Your account shows your orders, returns and saved addresses.",
    questions: [
      ["How do I reset my password?", "sign-in page"],
      ["Does my account show my orders?", "your orders"],
      ["Can I see saved addresses in my account?", "saved addresses"],
    ],
  },
  {
    id: "insurance",
    title: "Bike insurance",
    text: "We do not sell bike insurance ourselves. Many home insurance policies cover bikes, so check your policy first.",
    questions: [
      ["Do you sell bike insurance?", "do not sell bike insurance"],
      ["Does home insurance cover bikes?", "home insurance policies cover bikes"],
    ],
  },
  {
    id: "click-collect",
    title: "Click and collect",
    text: "Order online and collect from any store, usually within two days. We text you when your order is ready to collect.",
    questions: [
      ["Can I collect my order from a store?", "collect from any store"],
      ["How soon can I collect an online order?", "within two days"],
      ["Will you text me when my order is ready to collect?", "text you"],
    ],
  },
  {
    id: "trade-in",
    title: "Trading in your old bike",
    text: "Trade in your old bike for credit towards a new one. We value trade-ins at any store after a quick inspection.",
    questions: [
      ["Can I trade in my old bike?", "credit towards a new one"],
      ["How do you value a trade-in?", "quick inspection"],
    ],
  },
  {
    id: "kids-bikes",
    title: "Kids' bikes",
    text: "Kids' bikes are sized by wheel size from 12 to 24 inches. Our grow guarantee gives you 40 percent back when your child outgrows the bike.",
    questions: [
      ["How are kids' bikes sized?", "wheel size"],
      ["What is the grow guarantee?", "40 percent back"],
    ],
  },
  {
    id: "helmets",
    title: "Helmet safety",
    text: "Replace a helmet after any crash, even if it looks undamaged. Helmets should also be replaced every five years.",
    questions: [
      ["Should I replace a helmet after a crash?", "after any crash"],
      ["How often should helmets be replaced?", "every five years"],
    ],
  },
];
