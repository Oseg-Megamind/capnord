export const MODES = {
  plane: { icon: '✈️', label: 'Avion', color: '#8b5cf6', dash: '2 9', arc: true, speed: 650 },
  train: { icon: '🚆', label: 'Train', color: '#0ea5e9', speed: 110 },
  car: { icon: '🚗', label: 'Voiture', color: '#f97316', road: true, speed: 75 },
  bus: { icon: '🚌', label: 'Bus', color: '#22c55e', road: true, speed: 55 },
  van: { icon: '🚐', label: 'Van', color: '#eab308', road: true, speed: 65 },
  moto: { icon: '🏍️', label: 'Moto', color: '#ef4444', road: true, speed: 70 },
  ferry: { icon: '⛴️', label: 'Bateau', color: '#3b82f6', dash: '6 8', speed: 30 },
  bike: { icon: '🚲', label: 'Vélo', color: '#84cc16', speed: 15 },
  walk: { icon: '🥾', label: 'À pied', color: '#a855f7', dash: '1 7', speed: 4.5 },
  other: { icon: '🧭', label: 'Autre', color: '#64748b', speed: 60 },
};

export const STEP_TYPES = {
  city: { icon: '🏙️', label: 'Ville' },
  nature: { icon: '🏞️', label: 'Nature' },
  beach: { icon: '🏖️', label: 'Plage' },
  mountain: { icon: '⛰️', label: 'Montagne' },
  culture: { icon: '🏛️', label: 'Culture' },
  home: { icon: '🏠', label: 'Maison' },
  stop: { icon: '📍', label: 'Halte' },
};

export const SUB_TYPES = {
  visit: { icon: '🏛️', label: 'Visite' },
  activity: { icon: '🎟️', label: 'Activité' },
  food: { icon: '🍽️', label: 'Restaurant' },
  cafe: { icon: '☕', label: 'Café / bar' },
  hike: { icon: '🥾', label: 'Rando' },
  view: { icon: '📸', label: 'Point de vue' },
  beach: { icon: '🏖️', label: 'Plage' },
  shop: { icon: '🛍️', label: 'Shopping' },
  transport: { icon: '🚏', label: 'Transport' },
  other: { icon: '📌', label: 'Autre' },
};

export const EXP_CATS = {
  stay: { icon: '🛏️', label: 'Hébergement', color: '#6366f1' },
  transport: { icon: '🚆', label: 'Transport', color: '#0ea5e9' },
  fuel: { icon: '⛽', label: 'Carburant', color: '#a16207' },
  food: { icon: '🍽️', label: 'Nourriture', color: '#f97316' },
  activity: { icon: '🎟️', label: 'Activités', color: '#22c55e' },
  shopping: { icon: '🛍️', label: 'Shopping', color: '#ec4899' },
  health: { icon: '💊', label: 'Santé', color: '#ef4444' },
  other: { icon: '💼', label: 'Autre', color: '#64748b' },
};

export const DOC_TYPES = {
  passport: { icon: '🛂', label: 'Passeport / ID' },
  visa: { icon: '📄', label: 'Visa / ESTA' },
  insurance: { icon: '🩺', label: 'Assurance' },
  ticket: { icon: '🎫', label: 'Billet' },
  booking: { icon: '🧾', label: 'Réservation' },
  license: { icon: '🪪', label: 'Permis' },
  health: { icon: '💉', label: 'Santé / vaccins' },
  contact: { icon: '☎️', label: 'Contact utile' },
  other: { icon: '📎', label: 'Autre' },
};

export const BOOK_STATUS = {
  todo: { label: 'À réserver', cls: 'warn' },
  booked: { label: 'Réservé', cls: 'ok' },
  paid: { label: 'Payé', cls: 'ok' },
};

export const COLORS = ['#7a2436', '#1f4f9e', '#b8532e', '#2f6f62', '#8a6a2f', '#4b3f72', '#1d6f8a', '#5a5f66'];

export const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'JPY', 'AUD', 'NZD', 'THB', 'MAD', 'TND', 'MXN', 'BRL', 'IDR', 'VND', 'INR',
  'CNY', 'KRW', 'ZAR', 'TRY', 'SEK', 'NOK', 'DKK', 'ISK', 'PLN', 'CZK', 'HUF', 'RON', 'AED', 'SGD', 'HKD', 'PHP', 'MYR', 'PEN', 'COP',
  'ARS', 'CLP', 'LKR', 'EGP', 'XOF', 'XPF'];

export const LIST_TEMPLATES = {
  'Bagages': ['Passeport / carte d’identité', 'Chargeurs + batterie externe', 'Adaptateur prise', 'Trousse de toilette', 'Médicaments', 'Vêtements de pluie', 'Lunettes de soleil', 'Crème solaire', 'Écouteurs', 'Gourde'],
  'Avant le départ': ['Vérifier la validité du passeport', 'Visa / ESTA', 'Assurance voyage', 'Prévenir la banque', 'Forfait téléphone / eSIM', 'Télécharger les cartes hors-ligne', 'Check-in en ligne', 'Arroser les plantes / clés voisin'],
  'Trousse de secours': ['Pansements', 'Désinfectant', 'Paracétamol', 'Anti-diarrhéique', 'Antihistaminique', 'Répulsif moustique', 'Pince à épiler', 'Thermomètre'],
  'Road trip': ['Permis de conduire (+ international)', 'Carte grise / contrat de location', 'Gilet + triangle', 'Support téléphone', 'Câble voiture', 'Playlist hors-ligne', 'Glacière', 'Péages / vignette'],
};

export const WEATHER = (code) => {
  const w = (n, l) => [icon(n, 'wx-ico wx-' + n), l];
  if (code === 0) return w('sun', 'Ensoleillé');
  if (code <= 2) return w('sunCloud', 'Éclaircies');
  if (code === 3) return w('cloud', 'Couvert');
  if (code <= 48) return w('fog', 'Brouillard');
  if (code <= 57) return w('rain', 'Bruine');
  if (code <= 67) return w('rain', 'Pluie');
  if (code <= 77) return w('snow', 'Neige');
  if (code <= 82) return w('rain', 'Averses');
  if (code <= 86) return w('snow', 'Averses de neige');
  return w('storm', 'Orages');
};

// Monnaie locale par pays (code ISO du pays → code ISO de la monnaie)
export const COUNTRY_CURRENCY = Object.fromEntries(`
AD:EUR AT:EUR BE:EUR CY:EUR DE:EUR EE:EUR ES:EUR FI:EUR FR:EUR GR:EUR HR:EUR IE:EUR IT:EUR LT:EUR LU:EUR LV:EUR MC:EUR ME:EUR MT:EUR NL:EUR PT:EUR SI:EUR SK:EUR SM:EUR VA:EUR XK:EUR
GP:EUR MQ:EUR GF:EUR RE:EUR YT:EUR PM:EUR BL:EUR MF:EUR
PF:XPF NC:XPF WF:XPF
GB:GBP GG:GBP JE:GBP IM:GBP GI:GIP CH:CHF LI:CHF NO:NOK SE:SEK DK:DKK FO:DKK GL:DKK IS:ISK PL:PLN CZ:CZK HU:HUF RO:RON BG:BGN RS:RSD BA:BAM MK:MKD AL:ALL MD:MDL UA:UAH BY:BYN RU:RUB TR:TRY GE:GEL AM:AMD AZ:AZN
US:USD PR:USD VI:USD GU:USD EC:USD SV:USD PA:USD TL:USD FM:USD MH:USD PW:USD BQ:USD TC:USD VG:USD
CA:CAD MX:MXN GT:GTQ BZ:BZD HN:HNL NI:NIO CR:CRC CU:CUP DO:DOP HT:HTG JM:JMD BS:BSD BB:BBD TT:TTD KY:KYD BM:BMD AW:AWG CW:ANG
AG:XCD DM:XCD GD:XCD KN:XCD LC:XCD VC:XCD AI:XCD MS:XCD
CO:COP VE:VES PE:PEN BO:BOB CL:CLP AR:ARS UY:UYU PY:PYG BR:BRL GY:GYD SR:SRD FK:FKP
MA:MAD DZ:DZD TN:TND LY:LYD EG:EGP SD:SDG MR:MRU SN:XOF ML:XOF CI:XOF BF:XOF NE:XOF TG:XOF BJ:XOF GW:XOF
CM:XAF GA:XAF CG:XAF CF:XAF TD:XAF GQ:XAF GN:GNF SL:SLE LR:LRD GH:GHS NG:NGN GM:GMD CV:CVE ST:STN
ET:ETB ER:ERN DJ:DJF SO:SOS KE:KES UG:UGX TZ:TZS RW:RWF BI:BIF CD:CDF AO:AOA ZM:ZMW ZW:USD MW:MWK MZ:MZN
ZA:ZAR NA:NAD BW:BWP LS:LSL SZ:SZL MG:MGA MU:MUR SC:SCR KM:KMF SS:SSP
IL:ILS PS:ILS JO:JOD LB:LBP SY:SYP IQ:IQD IR:IRR SA:SAR AE:AED QA:QAR BH:BHD KW:KWD OM:OMR YE:YER
AF:AFN PK:PKR IN:INR NP:NPR BT:BTN BD:BDT LK:LKR MV:MVR KZ:KZT UZ:UZS KG:KGS TJ:TJS TM:TMT MN:MNT
CN:CNY HK:HKD MO:MOP TW:TWD JP:JPY KR:KRW KP:KPW
TH:THB VN:VND LA:LAK KH:KHR MM:MMK MY:MYR SG:SGD ID:IDR PH:PHP BN:BND
AU:AUD NZ:NZD FJ:FJD PG:PGK SB:SBD VU:VUV WS:WST TO:TOP KI:AUD NR:AUD TV:AUD CK:NZD
`.trim().split(/\s+/).map((p) => p.split(':')));

// Véhicules pour un road trip (consommation moyenne en L/100 km, modifiable)
export const VEHICLES = {
  car: { icon: '🚗', label: 'Voiture', short: 'voiture', conso: 6.5 },
  van: { icon: '🚐', label: 'Van / camping-car', short: 'van', conso: 10 },
  moto: { icon: '🏍️', label: 'Moto', short: 'moto', conso: 5 },
};

// Pictogrammes (traits, 24×24). Les véhicules regardent vers la droite = sens de la marche.
export const ICONS = {
  plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" transform="rotate(45 12 12)"/>',
  train: '<rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 11h16M12 3v8M8 18l-2 3M16 18l2 3"/><circle cx="8" cy="14.5" r=".6"/><circle cx="16" cy="14.5" r=".6"/>',
  car: '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>',
  bus: '<path d="M8 6v6M15 6v6M2 12h19.6M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><path d="M9 18h5"/><circle cx="16" cy="18" r="2"/>',
  van: '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2M15 18H9M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
  moto: '<circle cx="5" cy="16" r="3"/><circle cx="19" cy="16" r="3"/><path d="M5 16l4-6h5l3 6M13 10l2-4h3M9 10 8 8H5"/>',
  ferry: '<path d="M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1 .6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1M19.4 20A11.6 11.6 0 0 0 21 14l-9-4-9 4c0 2.9.9 5.3 2.8 7.8M19 13V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6M12 10v4M12 2v3"/>',
  bike: '<circle cx="5.5" cy="17.5" r="3.5"/><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>',
  walk: '<circle cx="13" cy="4" r="2"/><path d="M9 21l3-6 3 3v4M12 15l-1-5 4-1 3 3M11 10l-3 3"/>',
  other: '<circle cx="12" cy="12" r="10"/><path d="m16.2 7.8-2.1 6.3-6.3 2.1 2.1-6.3z"/>',
  route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  bed: '<path d="M2 4v16M2 8h18a2 2 0 0 1 2 2v10M2 17h20M6 8v9"/>',
  list: '<path d="m3 17 2 2 4-4M3 7l2 2 4-4M13 6h8M13 12h8M13 18h8"/>',
  tip: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z"/>',
  note: '<path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4M2 6h4M2 10h4M2 14h4M2 18h4M21.4 5.6a2.1 2.1 0 1 0-3-3l-5 5a2 2 0 0 0-.5.9l-.8 2.8a.5.5 0 0 0 .6.6l2.9-.8a2 2 0 0 0 .8-.5z"/>',
};
Object.assign(ICONS, {
  map: '<path d="M14.1 6.3 9.9 4.2a2 2 0 0 0-1.8 0L3.6 6.4A1 1 0 0 0 3 7.3v12.1a1 1 0 0 0 1.4.9l3.7-1.9a2 2 0 0 1 1.8 0l4.2 2.1a2 2 0 0 0 1.8 0l4.5-2.2a1 1 0 0 0 .6-.9V5.3a1 1 0 0 0-1.4-.9l-3.7 1.9a2 2 0 0 1-1.8 0zM15 6.8v13.5M9 3.8v13.5"/>',
  nav: '<path d="m3 11 19-9-9 19-2-8-8-2z"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
});
Object.assign(ICONS, {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>',
  sunCloud: '<path d="M12 2v2M4.9 4.9l1.4 1.4M20 12h2M19.1 4.9l-1.4 1.4M15.9 13A4 4 0 0 0 8 12"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9Z"/>',
  rain: '<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2M16 14v6M8 14v6M12 16v6"/>',
  snow: '<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2M8 15h.01M8 19h.01M12 17h.01M12 21h.01M16 15h.01M16 19h.01"/>',
  storm: '<path d="M6 16.3A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 .5 9M13 11l-4 6h6l-4 6"/>',
  fog: '<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2M16 17H7M17 21H9"/>',
});
export const icon = (name, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.other}</svg>`;
