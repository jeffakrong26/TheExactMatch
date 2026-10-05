// Brand-specific copy for the /sell/[brand] pages. All nine routes share
// pages/sell/brand.html, which on its own made them near-duplicates of each
// other (only the brand name changed) — the single biggest thin-content risk
// on the site. This is the per-brand content that makes each page its own.
//
// Rules for anything added here:
//   - No fabricated figures. No invented percentages, days-to-sell, or
//     "average offer" numbers — only things that are true of the brand in
//     general (which models/engines buyers hunt for, what hurts value).
//   - `notes` are trusted HTML (authored here, may contain internal links).
//   - `faqs` are PLAIN TEXT — they're rendered both on the page and into the
//     FAQPage JSON-LD from this same array, so the two can't drift apart.
//
// `article` is explicit for the same reason city `possessive` is: "an Aston
// Martin" isn't something to derive by string rules.

const LINK = 'color:var(--navy);font-weight:500;border-bottom:1px solid var(--gold);text-decoration:none';

export const SELL_BRAND_CONTENT = {
  porsche: {
    notes: [
      "The 911 drives most of the demand, and within it, specification matters more than at almost any other brand. GT cars (GT3, GT3 RS, GT4) and manual-transmission cars draw the deepest buyer pool, and desirable factory options — Sport Chrono, sport exhaust, front-axle lift, ceramic brakes, Paint to Sample colors — are things specialist buyers genuinely check the original window sticker for.",
      "What hurts value most: gaps in service history, modifications that aren't documented or reversible, and — on 996 and early 997 cars — no paper trail on the IMS bearing. Cayenne, Macan, Panamera and Taycan trade more like other luxury vehicles, where clean history and mileage do most of the talking.",
      "A well-specified, sensibly priced 911 tends to find its buyer quickly. The cars that sit are usually priced on emotion rather than on what comparable cars actually sold for — which is exactly the gap competing dealer offers close.",
    ],
    faqs: [
      [
        'Does mileage hit a Porsche harder than a normal car?',
        'Mileage bands matter more than the raw number — buyers mentally reset around thresholds like 30k, 50k, and 75k miles. A documented service history narrows the penalty considerably, especially on 911s.',
      ],
      [
        'Dealer or private party — where does a Porsche do better?',
        'Private party can net more, but it takes longer and invites tire-kickers. Our route gets you multiple real dealer offers within 24 hours, and having dealers compete for the car narrows the gap — without the listing circus.',
      ],
      [
        "Do modifications hurt my Porsche's resale?",
        "Generally yes, unless they're documented, reversible, and desirable (factory-approved parts). Tell us about them up front — it changes which buyers we route the car to.",
      ],
    ],
  },

  ferrari: {
    notes: [
      "With a Ferrari, the paperwork is part of the car. Buyers look first at the service book: consistent, dated service at an authorized Ferrari dealer is what separates a confident offer from a cautious one. On older mid-engine V8s like the 360 and F430, proof of a recent major (belt) service is one of the first things a serious buyer asks for.",
      "Specification matters too. Carbon fiber packages, Daytona-style seats, Scuderia shields and a classic color combination widen the buyer pool; an unusual spec can narrow it. Gated-manual cars have become collectible in their own right. Accident history and undocumented modifications are the fastest way to lose money.",
      "On newer cars, Ferrari's factory maintenance program stays with the car when it changes hands — if yours is still inside it, that belongs front and center when it goes to buyers.",
    ],
    faqs: [
      [
        'Does it matter where my Ferrari was serviced?',
        "Yes. Authorized-dealer service history is what most Ferrari buyers expect, and gaps or undocumented independent work make them cautious. Send us whatever records you have — service book, invoices, receipts — and we'll present the car with them.",
      ],
      [
        'Should I do the major service before selling?',
        "If it's due or close to due, buyers will price it into their offer either way. If it was done recently, the invoice is a selling point. Tell us when it was last done and we'll tell you whether it's worth doing first.",
      ],
      [
        'Do the original window sticker and accessories matter?',
        "They help. The original window sticker, both keys, the car cover, battery tender and owner's manuals all signal a car that's been looked after — and buyers notice when they're missing.",
      ],
    ],
  },

  lamborghini: {
    notes: [
      "For Gallardo and Murciélago owners, the transmission story carries a lot of weight. On e-gear cars a Lamborghini dealer can read clutch wear electronically, and a recent reading is one of the first things buyers ask for. Manual Gallardos are rare and draw a dedicated following of their own.",
      "On the Huracán and Aventador, limited trims — Performante, STO, Tecnica, SVJ — and options like the front-axle lift, carbon ceramic brakes and carbon packages move the number most. Front-end damage, aftermarket exhausts, and color-change wraps hiding the original paint are what buyers inspect hardest.",
      "The Urus sells in a different, larger market — closer to other high-end SUVs — where mileage, warranty status and clean history do most of the work.",
    ],
    faqs: [
      [
        'Do I need a clutch wear report to sell my Lamborghini?',
        'For an e-gear Gallardo or Murciélago, it is strongly recommended — buyers will ask, and a recent reading from a Lamborghini dealer removes a big unknown. Huracán and later cars use dual-clutch transmissions, so it matters far less there.',
      ],
      [
        'Does a wrap or PPF affect value?',
        'Professionally installed paint protection film is generally a plus. Full color-change wraps are neutral at best — buyers want to see the original paint, so be ready to show it or disclose what is underneath.',
      ],
    ],
  },

  mclaren: {
    notes: [
      "McLaren buyers weigh warranty status more heavily than buyers of most exotics. A car still under factory warranty, or eligible for McLaren's extended warranty, is a far easier sale than one that isn't — so the service history and inspections that keep it eligible directly affect what dealers will offer.",
      "Within the lineup, the Super Series (12C, 650S, 720S, 750S) and limited cars like the 675LT and 765LT draw the most specialist interest. Sports Series cars (540C, 570S, 600LT) and the GT trade in a broader market where mileage and condition carry more weight. Carbon packs, MSO paint and the vehicle-lift system all help.",
      "Expect buyers to ask about software updates and open campaigns. Records showing they were handled by a McLaren retailer remove a common hesitation before it comes up.",
    ],
    faqs: [
      [
        'Does extended warranty eligibility matter when selling my McLaren?',
        "Yes, a lot. Many buyers will only consider a car that's covered or can be. If yours is covered, tell us when it expires; if it has lapsed, we route it to buyers who are comfortable without it.",
      ],
      [
        'How much does mileage matter on a McLaren?',
        'Less than history and warranty status. Low-mileage examples of limited models attract collectors, while higher-mileage Sports Series cars sell to drivers — we match the car to the right group of buyers.',
      ],
    ],
  },

  'rolls-royce': {
    notes: [
      "Almost every Rolls-Royce is bespoke, and that cuts both ways when you sell. A classic specification — understated exterior, light interior, sought-after options like the Starlight Headliner — appeals to the widest set of buyers. A highly personal color combination can be the reason the car was special to you, and also the reason it takes a dealer longer to place.",
      "Rolls-Royces depreciate meaningfully in their early years, so dealers price with a close eye on recent comparable sales. Cars that still qualify for Provenance, Rolls-Royce's certified pre-owned program, carry extra reassurance for the next owner.",
      "Cullinan, Ghost, Phantom, Wraith and Dawn each have a distinct buyer — the person shopping a Dawn convertible is rarely the person shopping a Cullinan — which is why we route the car to dealers who actually sell that model.",
    ],
    faqs: [
      [
        "Does my Rolls-Royce's custom specification hurt resale?",
        "It can narrow the buyer pool, but it rarely makes a car hard to sell — it changes who the right buyer is. Send us the full build details and we'll target the dealers and buyers who want that spec.",
      ],
      [
        'Does certified pre-owned eligibility matter?',
        "It helps. A car that still qualifies for Rolls-Royce Provenance gives a franchised dealer a clear path to retail it with factory backing, and that's reflected in how they bid.",
      ],
    ],
  },

  bentley: {
    notes: [
      "Bentley buyers think hard about running costs. On the Continental GT, Flying Spur and Bentayga, the V8 and W12 versions appeal to different people: the V8 for its running costs and balance, the W12 for its smoothness and the prestige of Speed and Mulliner trims.",
      "Service history matters more than usual, because deferred maintenance on a Bentley is expensive to catch up on and buyers price it in. Inspections focus on air suspension, electrical systems, and tire and brake wear. Mulliner and Speed specifications, and well-chosen interior color combinations, help.",
      "Like other ultra-luxury brands, Bentleys depreciate quickly in their first years — which makes comparing multiple real offers matter more. The spread between the lowest and highest dealer number is real money.",
    ],
    faqs: [
      [
        'Does it matter whether my Bentley is a V8 or W12?',
        'It changes the buyer, not whether it sells. Both have a real market, and we route the car to dealers who regularly sell that configuration.',
      ],
      [
        'What should I have ready before selling my Bentley?',
        'Service records, both keys, and notes on any recent work on the air suspension, brakes or tires. Documented recent maintenance answers the first questions every buyer asks.',
      ],
    ],
  },

  tesla: {
    notes: [
      "Selling a Tesla is closer to selling a piece of technology than a traditional car. Buyers look first at battery health and real-world range, then at the hardware and software: which Autopilot computer the car has, and whether features like Full Self-Driving or an acceleration boost are active on it.",
      "Because Tesla manages features through software, it's worth confirming exactly what's active on the car before it goes to buyers — dealers will check. Accident and repair history matter too; buyers want to know whether repairs were done at a Tesla-approved body shop.",
      "Used Tesla values move with Tesla's own new-car pricing, so timing matters more than with most brands. Competing dealer offers give you a clear read on today's number instead of a single trade-in quote.",
    ],
    faqs: [
      [
        "Does my Tesla's battery health affect the offer?",
        "Yes — it's one of the first things buyers check. Note the car's estimated range at full charge and share any battery or service records you have.",
      ],
      [
        'Will Full Self-Driving add value when I sell?',
        "It can, if it's active on the car itself. Confirm it shows on the vehicle before you sell and tell us — it changes which buyers are interested.",
      ],
      [
        "Is Tesla's own trade-in offer my best option?",
        "It's one data point. We bring back competing offers from dealers so you can compare against it before you decide.",
      ],
    ],
  },

  'aston-martin': {
    article: 'an',
    notes: [
      "Aston Martin buyers split clearly by engine. The current Vantage, DB11 V8 and DBX use a Mercedes-AMG-sourced twin-turbo V8, while V12 cars — DB11 V12, DBS, Vanquish, V12 Vantage — draw a more collector-minded buyer. Manual cars like the Vantage AMR and V12 Vantage S manual are a rare niche of their own.",
      `Service history at an authorized Aston Martin dealer, and eligibility for the Timeless certified pre-owned program, carry real weight. On the 2019+ Vantage, buyers also ask about the known issues covered in our <a href="/guides/aston-martin-vantage-v8" style="${LINK}">Vantage V8 buyer's guide</a> — documentation that they've been addressed helps.`,
      `Aston Martins depreciate quickly early on, which makes real competing offers worth more than a single quote. We work Aston Martin deals from the buying side too — see the real numbers in our <a href="/advice/how-to-negotiate-car-price" style="${LINK}">negotiation guide</a>.`,
    ],
    faqs: [
      [
        'V8 or V12 — does it change how my Aston Martin sells?',
        "Yes — they attract different buyers. V8 cars sell on usability and running costs; V12 cars draw buyers who want the more traditional, collectible Aston. We route the car accordingly.",
      ],
      [
        'Does Timeless certified pre-owned eligibility matter?',
        'It helps. It lets a franchised Aston Martin dealer retail the car with factory-backed coverage, which makes your car more attractive to exactly the dealers most likely to want it.',
      ],
    ],
  },

  maserati: {
    notes: [
      "Maserati is one of the brands where who you sell to matters most. The Ghibli, Levante and Quattroporte trade in a broad luxury market and depreciate steeply, so a single instant-offer number can land well below what a dealer who actually retails Maseratis would pay. Getting the car in front of the right buyers is most of the job.",
      "Enthusiasts pay close attention to the engine: the Ferrari-built V8s in the GranTurismo and Trofeo models, and the MC20's Nettuno V6, draw a more dedicated buyer than the volume V6 cars. Well-kept GranTurismo and GranCabrio models have a following of their own.",
      "What hurts value: missing service records, unresolved warning lights, and worn interiors. A documented recent service and a clean inspection go a long way.",
    ],
    faqs: [
      [
        'Why do Maserati offers vary so much between dealers?',
        "Many dealers don't specialize in the brand and price in that uncertainty. Dealers that regularly sell Maseratis know the market and bid with more confidence — that's who we send your car to.",
      ],
      [
        'Does a Ferrari-built engine add value?',
        'For enthusiasts, yes — V8 GranTurismo and Trofeo models draw a more dedicated buyer than the V6 volume models. Tell us exactly which engine and trim you have.',
      ],
    ],
  },
};
