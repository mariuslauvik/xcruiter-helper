// Xcruiter ad helper — v0.3 (5 distinkte annonser per kjøring)
//
// Flow:
//   1. Finn første jobb i Stillinger med Status = "Levert".
//   2. Les jobb + slå opp kunde (Kunde-relasjon eller navnematch på "Ditt firma").
//      Les ALLE filer i jobbens "Bilder til annonse" og kundens Bildebibliotek/Logo.
//   3. analyzeAssets(): vision-analyse av alle opplastede bilder med Claude
//      (claude-sonnet-4-6) — kategori, kvalitet, om de er brukbare som annonsebilde.
//   4. buildChecklist(): regler fra data + analyse som styrer prompt-bygging.
//   5. planFiveAds(): ett Claude-kall returnerer 5 distinkte konsepter
//      (renTekst, foto, fordeler, spørsmål, premium — eller egne distinkte).
//   6. generateFiveAds(): én GPT Image 2-genereringer per konsept (n=1).
//      Ekte brukbart bilde → images.edit; ellers images.generate med realisme-prompt.
//      Hvis logo finnes → sharp-compositing av logo på topp-venstre av safe zone.
//   7. saveAds() lokalt + publishToNotion() fester alle 5 til "Annonser"
//      og setter status → "Annonse laget".
//
// Run:  node xcruiter-helper.mjs           (local poll loop, every 5 min)
//   or: RUN_ONCE=true node ...             (single pass — used by GitHub Actions cron)

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client as Notion } from '@notionhq/client';
import OpenAI, { toFile } from 'openai';
import Anthropic from '@anthropic-ai/sdk';

// ─────────────────────────────────────────────────────────────────────────────
// Config — the only things you should ever need to change.
// ─────────────────────────────────────────────────────────────────────────────
const STILLINGER_DS = 'c0a69668-b0c1-405c-a6df-b9464395abd6'; // Stillinger data source
const KUNDER_DS      = '713cc956-67c6-4731-8441-3f5cbdc47e5c'; // Kunder data source (kept for reference)

const STATUS_READY = 'Levert';
const STATUS_DONE  = 'Annonse laget';
const POLL_INTERVAL_MS = 5 * 60 * 1000; // sjekk Notion hvert 5. minutt (kun lokalt — GitHub Actions bruker RUN_ONCE)

const NOTION_INPUT_PHOTO_COL  = 'Bilder til annonse'; // kundens jobb-spesifikke bilde (på Stillinger)
const NOTION_OUTPUT_FILE_COL  = 'Annonser';            // ferdige annonser legges her (på Stillinger)

const IMAGE_MODEL   = 'gpt-image-2';   // OpenAI GPT Image 2
const IMAGE_SIZE    = '1088x1920';     // 9:16; width+height must be divisible by 16 (1080 is not)
const IMAGE_QUALITY = 'high';          // low | medium | high

const TYPE_TOKEN = {
  renTekst:  'RenTekst',
  foto:      'Foto',
  fordeler:  'Fordeler',
  spørsmål:  'Spørsmål',
  premium:   'Premium',
};

// Hvor og hvor stor logoen skal være per konsepttype. Posisjon beskriver hvor i
// safe zone (y=285..1635) logoen lander; bredden er i prosent av annonsens bredde.
// Disse verdiene styrer både compositing og prompten (sånn at GPT Image 2 lar
// området være tomt).
const LOGO_PLACEMENT = {
  renTekst:  { posisjon: 'topp-senter',  bredeProsent: 22, beskrivelse: 'top-center as a bold brand statement' },
  foto:      { posisjon: 'topp-venstre', bredeProsent: 12, beskrivelse: 'top-left corner, small and unobtrusive over the photo' },
  fordeler:  { posisjon: 'topp-høyre',   bredeProsent: 10, beskrivelse: 'top-right corner, small accent mark' },
  spørsmål:  { posisjon: 'bunn-senter',  bredeProsent: 16, beskrivelse: 'bottom-center, medium, like an editorial signoff' },
  premium:   { posisjon: 'topp-senter',  bredeProsent: 14, beskrivelse: 'top-center, refined wordmark scale with generous whitespace below' },
};
const DEFAULT_LOGO_PLACEMENT = LOGO_PLACEMENT.foto;

const COPY_MODEL = 'claude-sonnet-4-6'; // change if your account uses a different model string

const OUTPUT_DIR = path.resolve('./output');

// ─────────────────────────────────────────────────────────────────────────────
// Clients
// ─────────────────────────────────────────────────────────────────────────────
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name} (set it in .env)`);
  return v;
}
const notion    = new Notion({ auth: requireEnv('NOTION_TOKEN') });
const openai    = new OpenAI({ apiKey: requireEnv('OPENAI_API_KEY') });
const anthropic = new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });

// ─────────────────────────────────────────────────────────────────────────────
// Small Notion property readers (handles the typed property objects)
// ─────────────────────────────────────────────────────────────────────────────
const txt = (p) => {
  if (!p) return '';
  if (p.type === 'title')      return (p.title[0]?.plain_text ?? '').trim();
  if (p.type === 'rich_text')  return (p.rich_text[0]?.plain_text ?? '').trim();
  if (p.type === 'select')     return (p.select?.name ?? '').trim();
  if (p.type === 'url')        return (p.url ?? '').trim();
  if (p.type === 'number')     return p.number ?? null;
  if (p.type === 'date')       return (p.date?.start ?? '').trim();
  return '';
};
const firstRelationId = (p) => p?.relation?.[0]?.id ?? null;
const fileUrl = (f) => (f.type === 'external' ? f.external.url : f.file?.url) ?? null;
const firstFileUrl = (p) => {
  const f = p?.files?.[0];
  return f ? fileUrl(f) : null;
};
const allFileUrls = (p) => (p?.files ?? []).map(fileUrl).filter(Boolean);

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — find one job that is ready for an ad
// ─────────────────────────────────────────────────────────────────────────────
async function findReadyJob() {
  const res = await notion.dataSources.query({
    data_source_id: STILLINGER_DS,
    filter: { property: 'Status', select: { equals: STATUS_READY } },
    page_size: 1,
  });
  return res.results[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — read job + linked customer into plain variables
// ─────────────────────────────────────────────────────────────────────────────
function parseColors(s) {
  const alle = (s || '').match(/#[0-9A-Fa-f]{6}/g) || [];
  return {
    alle,                              // alle hex som ble funnet (lengde 0..N)
    primer:   alle[0] || '#1B3A2F',
    sekunder: alle[1] || '#E8DCC4',
    aksent:   alle[2] || '#C2410C',
  };
}

async function findKundeRowByName(name) {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  // Title-eiendomsfilteret matcher delstrenger (case-insensitive), så vi henter
  // kandidater og velger eksakt match først, ellers første treff.
  const res = await notion.dataSources.query({
    data_source_id: KUNDER_DS,
    filter: { property: 'Bedriftsnavn', title: { contains: trimmed } },
    page_size: 10,
  });
  const lower = trimmed.toLowerCase();
  return (
    res.results.find((r) =>
      r.properties.Bedriftsnavn?.title?.[0]?.plain_text?.trim().toLowerCase() === lower
    ) ??
    res.results[0] ??
    null
  );
}

function buildCustFromPage(custPage, fallbackName) {
  if (!custPage) {
    // Ingen Kunder-rad funnet — bruk firmanavn fra skjemaet med default branding.
    return {
      merke:   fallbackName,
      kode:    '',
      font:    '',
      stemme:  '',
      url:     '',
      ...parseColors(''),         // alle:[], + default primer/sekunder/aksent
      bildebibliotekUrls: [],
      bildebibliotekUrl:  null,   // BC: peker på første hvis noen
      logoUrls:           [],
      logoUrl:            null,
      kilde:   'fallback (ingen Kunder-rad matchet)',
    };
  }
  const cp = custPage.properties;
  const bildebibliotekUrls = allFileUrls(cp['Bildebibliotek']);
  const logoUrls           = allFileUrls(cp['Logo']);
  return {
    merke:   txt(cp['Bedriftsnavn']) || fallbackName,
    kode:    txt(cp['Merkekode']),
    font:    txt(cp['Font']),
    stemme:  txt(cp['Merkevarestemme']),
    url:     txt(cp['Nettside']),
    ...parseColors(txt(cp['Merkevarefarger'])),
    bildebibliotekUrls,
    bildebibliotekUrl: bildebibliotekUrls[0] ?? null,
    logoUrls,
    logoUrl:           logoUrls[0] ?? null,
    kilde:   `Kunder-rad (${txt(cp['Bedriftsnavn'])})`,
  };
}

async function readJobAndCustomer(jobPage) {
  const jp = jobPage.properties;
  const jobbPhotoUrls = allFileUrls(jp[NOTION_INPUT_PHOTO_COL]);
  const job = {
    pageId: jobPage.id,
    tittel:        txt(jp['Stillingstittel']),
    type:          txt(jp['Ansettelsestype']),    // nå rich_text (txt() håndterer begge)
    sted:          txt(jp['Lokasjon']),
    vinkel:        txt(jp['Annonsevinkel']),
    beskrivelse:   txt(jp['Beskrivelse']),
    soknadslenke:  txt(jp['Søknadslenke']),
    soknadsfrist:  txt(jp['Søknadsfrist']),       // NY (date)
    brandFargerRaw:txt(jp['Brand farger']),       // NY: fallback fargekilde
    dittFirma:     txt(jp['Ditt firma']),
    kundeId:       firstRelationId(jp['Kunde']),
    jobbPhotoUrls,                                // NY: hele lista
    jobbPhotoUrl:  jobbPhotoUrls[0] ?? null,      // BC til § 2 tar over
  };

  // Hent Kunder-rad — først via relasjonen hvis satt manuelt,
  // ellers via navnematch på "Ditt firma".
  let custPage = null;
  if (job.kundeId) {
    custPage = await notion.pages.retrieve({ page_id: job.kundeId });
  } else if (job.dittFirma) {
    custPage = await findKundeRowByName(job.dittFirma);
  }

  const cust = buildCustFromPage(custPage, job.dittFirma || 'Vår bedrift');

  // Fargekilde-presedens: kundens Merkevarefarger > stillingens Brand farger > defaults.
  // parseColors leverer alltid defaults i primer/sekunder/aksent — vi sjekker `alle` for
  // å se om kilden faktisk hadde hex-koder.
  if (cust.alle.length === 0 && job.brandFargerRaw) {
    const jobbFarger = parseColors(job.brandFargerRaw);
    if (jobbFarger.alle.length > 0) {
      cust.alle     = jobbFarger.alle;
      cust.primer   = jobbFarger.primer;
      cust.sekunder = jobbFarger.sekunder;
      cust.aksent   = jobbFarger.aksent;
      cust.fargerKilde = 'stillingens "Brand farger"';
    } else {
      cust.fargerKilde = 'defaults';
    }
  } else {
    cust.fargerKilde = cust.alle.length > 0 ? 'kundens Merkevarefarger' : 'defaults';
  }

  return { job, cust };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2b — analyser alle opplastede bilder med Claude vision (§ 2)
// ─────────────────────────────────────────────────────────────────────────────
const SUPPORTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

async function fetchImageAsBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  let mediaType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!SUPPORTED_IMAGE_TYPES.includes(mediaType)) mediaType = 'image/jpeg';
  return { buffer, mediaType };
}

async function analyzeOneImage(url, source) {
  try {
    const { buffer, mediaType } = await fetchImageAsBuffer(url);
    const msg = await anthropic.messages.create({
      model: COPY_MODEL,
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } },
          { type: 'text', text:
            'Analyser bildet for bruk i en norsk stillingsannonse. Returner KUN rå JSON, ingen markdown, ingen forklaring:\n' +
            '{"hva":"<kort beskrivelse>","type":"person|arbeidsplass|produkt|logo|annet",' +
            '"brukbar_som_annonsebilde":true|false,"kvalitet":"høy|middels|lav","notat":"<kort>"}'
          },
        ],
      }],
    });
    const raw = msg.content[0].text.trim().replace(/^```json\s*|\s*```$/g, '');
    const analyse = JSON.parse(raw);
    return { url, source, buffer, mediaType, analyse, feil: null };
  } catch (err) {
    return { url, source, buffer: null, mediaType: null, analyse: null, feil: err.message };
  }
}

async function loadLogoOnly(url) {
  // Logo-kolonnen er per definisjon en logo — vi trenger bare bytene til § 5
  // (compositing). Vision-analyse hoppes over for å spare et Claude-kall.
  try {
    const { buffer, mediaType } = await fetchImageAsBuffer(url);
    return {
      url, source: 'logo', buffer, mediaType,
      analyse: { type: 'logo', brukbar_som_annonsebilde: false, kvalitet: 'høy', hva: 'logo fra Logo-kolonnen', notat: 'ikke vision-analysert' },
      feil: null,
    };
  } catch (err) {
    return { url, source: 'logo', buffer: null, mediaType: null, analyse: null, feil: err.message };
  }
}

async function analyzeAssets({ job, cust }) {
  // Bilder fra jobb + bibliotek analyseres med vision; logo lastes bare ned.
  const visionTasks = [
    ...job.jobbPhotoUrls.map((u) => analyzeOneImage(u, 'jobb')),
    ...cust.bildebibliotekUrls.map((u) => analyzeOneImage(u, 'bibliotek')),
  ];
  const logoTasks = cust.logoUrls.map(loadLogoOnly);
  const [analyserte, logoer] = await Promise.all([
    Promise.all(visionTasks),
    Promise.all(logoTasks),
  ]);
  const alle = [...analyserte, ...logoer];

  // Brukbare ekte bilder = vision sa OK OG ikke flagget som logo (logoer skal ikke
  // brukes som hovedbilde i annonsen).
  const brukbareEkteBilder = analyserte.filter(
    (r) => r.analyse?.brukbar_som_annonsebilde === true && r.analyse?.type !== 'logo'
  );

  // Logo-kandidat: først eksplisitt Logo-kolonne, ellers vision som flagger 'logo'.
  const logoFil =
    logoer.find((r) => !r.feil) ??
    analyserte.find((r) => r.analyse?.type === 'logo' && !r.feil) ??
    null;

  return { alle, brukbareEkteBilder, logoFil };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2c — sjekkliste fra data + bildeanalyse (§ 3)
// Disse svarene styrer hvordan §4-promptene bygges og hvilke regler som håndheves.
// ─────────────────────────────────────────────────────────────────────────────
function buildChecklist({ job, cust, assets }) {
  const harBrukbartJobbBilde      = assets.brukbareEkteBilder.some((b) => b.source === 'jobb');
  const harBrukbartBibliotekBilde = assets.brukbareEkteBilder.some((b) => b.source === 'bibliotek');
  const harBrukbartEktebilde      = assets.brukbareEkteBilder.length > 0;
  const harLogo            = !!assets.logoFil;
  const harFarger          = cust.alle.length > 0;
  const harAnsettelsestype = !!job.type;
  const harLokasjon        = !!job.sted;
  const harVinkel          = !!job.vinkel;
  const harBeskrivelse     = !!job.beskrivelse;

  return {
    // Boolean-flagg
    harBrukbartJobbBilde,
    harBrukbartBibliotekBilde,
    harBrukbartEktebilde,
    harLogo,
    harFarger,
    harAnsettelsestype,
    harLokasjon,
    harVinkel,
    harBeskrivelse,

    // Regler downstream må håndheve i § 4–§ 5
    regler: {
      ansettelsestypeMinstAntall: harAnsettelsestype ? 2 : 0,  // synlig i ≥2 annonser
      lokasjonMinstAntall:        harLokasjon ? 1 : 0,         // synlig i ≥1 annonse
      fargerIAlle:                harFarger,                    // primær/sekundær/aksent i alle
      logoIAlle:                  harLogo,                      // logo i alle (composited el. ordmerke)
      foretrekkEkteBildeOverGenerering: harBrukbartEktebilde,
    },

    // Primær budskaps-kilde for Claude i § 4
    primærBudskap: {
      vinkel:      job.vinkel,
      beskrivelse: job.beskrivelse,
      // "Beskrivelsen er viktigst" — den må forstås før noe genereres
      viktigst:   'beskrivelse',
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — planlegg 5 distinkte annonse-konsepter (§ 4)
// ─────────────────────────────────────────────────────────────────────────────
async function planFiveAds({ job, cust, assets, checklist }) {
  // Index over brukbare ekte bilder så Claude kan referere via bilde_indeks.
  const bildeKatalog = assets.brukbareEkteBilder.length === 0
    ? '  (ingen brukbare ekte bilder — konsepter må enten være ren tekst eller generere visuell)'
    : assets.brukbareEkteBilder.map((b, i) =>
        `  [${i}] kilde=${b.source}, type=${b.analyse?.type}, kvalitet=${b.analyse?.kvalitet}, hva="${b.analyse?.hva}"`
      ).join('\n');

  const fargerLinje = checklist.harFarger
    ? `primær=${cust.primer}, sekundær=${cust.sekunder}, aksent=${cust.aksent}`
    : 'mangler — bruk nøytral premium-palett';

  const system =
    'Du er en norsk reklametekstforfatter og art director som planlegger fem distinkte ' +
    'stillingsannonse-konsepter for SAMME stilling. Mål: maksimal diversitet for Meta Andromeda. ' +
    'Skriv kort, menneskelig norsk. Ingen AI-klisjeer, ingen "spennende muligheter"-floskler, ingen ' +
    'rule-of-three, ingen em-dash-spam. Folk søker en bedre hverdag. Korrekt å og ø overalt. ' +
    'Forstå beskrivelsen først (primærkilden), så vinkelen. ' +
    'Svar KUN med rå JSON-array, ingen markdown, ingen forklaring.';

  const user =
    `MERKE: ${cust.merke}\n` +
    `STEMME: ${cust.stemme || '(ikke satt)'}\n` +
    `FARGER: ${fargerLinje}\n` +
    `LOGO TILGJENGELIG: ${checklist.harLogo ? 'ja' : 'nei'}\n` +
    `\n` +
    `STILLING: ${job.tittel}\n` +
    `ANSETTELSESTYPE: ${job.type || '(ikke satt)'}\n` +
    `LOKASJON: ${job.sted || '(ikke satt)'}\n` +
    `VINKEL: ${job.vinkel || '(ikke satt)'}\n` +
    `BESKRIVELSE (primærkilde — forstå denne først): ${job.beskrivelse || '(ikke satt)'}\n` +
    `\n` +
    `BRUKBARE EKTE BILDER (referer med bilde_indeks):\n${bildeKatalog}\n` +
    `\n` +
    `OPPGAVE: Lag NØYAKTIG 5 distinkte konsepter for denne stillingen.\n` +
    `\n` +
    `KONSEPT 1 MÅ være type "renTekst": typografisk, minimalt, ingen/lite foto, ` +
    `logo hvis tilgjengelig, merkefarger. Ikke fancy.\n` +
    `KONSEPT 2–5: fire helt ulike retninger. Anbefalte typer (du kan designe egne så lenge de er distinkte):\n` +
    `  - "foto": stort ekte bilde av person/arbeidsplass, hook over\n` +
    `  - "fordeler": punktene som helten, typografisk\n` +
    `  - "spørsmål": direkte spørsmål-hook til kandidaten (f.eks. "Lei av tilfeldig turnus?")\n` +
    `  - "premium": stilrent merkefarge-drevet, sofistikert redaksjonelt\n` +
    `\n` +
    `REGLER SOM MÅ OPPFYLLES på tvers av de 5 konseptene:\n` +
    `- Ansettelsestype ${checklist.harAnsettelsestype ? `synlig i MINST ${checklist.regler.ansettelsestypeMinstAntall} konsepter (bruk_ansettelsestype:true)` : '— ikke tilgjengelig, sett bruk_ansettelsestype:false overalt'}.\n` +
    `- Lokasjon ${checklist.harLokasjon ? `synlig i MINST ${checklist.regler.lokasjonMinstAntall} konsept (bruk_lokasjon:true)` : '— ikke tilgjengelig, sett bruk_lokasjon:false overalt'}.\n` +
    `- Merkefarger brukes i ALLE konsepter (fargebruk-feltet beskriver hvordan).\n` +
    `- Logo ${checklist.harLogo ? 'i ALLE konsepter (bruk_logo:true)' : 'mangler — sett bruk_logo:false; bruk merkenavnet som ordmerke i merkefont i stedet'}.\n` +
    `- Foretrekk ekte bilder (visual.mode="bruk_bilde", med gyldig bilde_indeks) der konseptet passer; bruk "generer" KUN når ingen ekte bilde passer eller konseptet (f.eks. renTekst) ikke trenger foto.\n` +
    `- Hver hook (hook_l1 + hook_l2) ≤ 72 tegn TOTALT. Punktene 2–4 ord hver.\n` +
    `\n` +
    `JSON-skjema per konsept:\n` +
    `{\n` +
    `  "type": "renTekst|foto|fordeler|spørsmål|premium",\n` +
    `  "layout": "kort beskrivelse av oppsettet",\n` +
    `  "hook_l1": "...", "hook_l2": "...", "hook_nokkelord": "ord fra hooken som skal ha aksentfarge",\n` +
    `  "punkter": ["...", "...", "..."],\n` +
    `  "visual": { "mode": "bruk_bilde|generer", "bilde_indeks": 0, "generer_beskrivelse": "<hvis generer: hva som skal genereres>" },\n` +
    `  "bruk_logo": true|false,\n` +
    `  "bruk_ansettelsestype": true|false,\n` +
    `  "bruk_lokasjon": true|false,\n` +
    `  "fargebruk": "hvordan primær/sekundær/aksent brukes i akkurat dette konseptet"\n` +
    `}\n` +
    `\n` +
    `Svar med JSON-array av nøyaktig 5 elementer; første element MÅ ha type "renTekst".`;

  const msg = await anthropic.messages.create({
    model: COPY_MODEL,
    max_tokens: 2000,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const raw = msg.content[0].text.trim().replace(/^```json\s*|\s*```$/g, '');
  const concepts = JSON.parse(raw);

  if (!Array.isArray(concepts) || concepts.length !== 5) {
    throw new Error(`planFiveAds: forventet array med 5 konsepter, fikk ${Array.isArray(concepts) ? concepts.length : typeof concepts}`);
  }
  // Avled hook_hele + valider bilde-indeks
  const maxIndex = Math.max(0, assets.brukbareEkteBilder.length - 1);
  for (const c of concepts) {
    c.hook_hele = `${c.hook_l1 || ''} ${c.hook_l2 || ''}`.trim();
    if (c.visual?.mode === 'bruk_bilde') {
      const idx = c.visual.bilde_indeks ?? 0;
      if (assets.brukbareEkteBilder.length === 0 || idx > maxIndex || idx < 0) {
        // Ugyldig referanse — degrader til generer.
        c.visual = { mode: 'generer', bilde_indeks: null, generer_beskrivelse: c.visual.generer_beskrivelse || 'realistisk relevant scene' };
      }
    }
  }
  return concepts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4 — bygg prompt PER konsept + realisme + logo-compositing (§ 5)
// ─────────────────────────────────────────────────────────────────────────────
function buildConceptPrompt(concept, { cust, job, checklist, willCompositeLogo, logoPlacement }) {
  const fargerLinje = checklist.harFarger
    ? `background ${cust.primer}, body text ${cust.sekunder}, accents and CTA ${cust.aksent}`
    : 'neutral premium palette: soft warm dark background, off-white text, one tasteful accent color';

  const hookL1 = concept.hook_l1 || '';
  const hookL2 = concept.hook_l2 || '';
  const hookWhole = concept.hook_hele || `${hookL1} ${hookL2}`.trim();
  const punkter = Array.isArray(concept.punkter) ? concept.punkter : [];
  const ansettelsestype = concept.bruk_ansettelsestype && job.type ? job.type : '';
  const lokasjon = concept.bruk_lokasjon && job.sted ? job.sted : '';
  const rolleLinje = [ansettelsestype, lokasjon].filter(Boolean).join(' · ');

  // Logo-håndtering: hvis vi compositerer logo i etterkant, må modellen LA det
  // valgte området være tomt — plassering og bredde varierer per konsepttype.
  const logoBlock = willCompositeLogo && logoPlacement
    ? `LEAVE CLEAN SPACE for the real logo (${logoPlacement.beskrivelse}, approximately ${logoPlacement.bredeProsent}% of width). Position: ${logoPlacement.posisjon}. Do NOT render any logo, wordmark, badge or graphic in that exact area — it will be composited on top in post-processing.`
    : `Render the wordmark "${cust.merke}" in ${cust.sekunder} uppercase ${cust.font || 'sans-serif'}-style letters at the top of the safe zone.`;

  // Sterk realisme-formulering KUN når vi må generere visuell.
  const realismBlock = concept.visual?.mode === 'generer'
    ? `REALISM CRITICAL — generated imagery MUST look like a real candid photograph: shot on a real camera with a real lens (35–50mm), natural directional daylight, real skin texture with visible pores, fine lines and small imperfections (never plastic-smooth, never waxy, never glossy CG sheen), asymmetrical natural features, relaxed unposed expression, anatomically correct hands with EXACTLY five fingers, natural teeth and eyes with subtle imperfections, real worn clothing with creases, slight film grain. STRICTLY FORBIDDEN: waxy or plastic skin, perfect facial symmetry, HDR glow, extra or missing fingers, mannequin/CGI look, airbrushed magazine retouching, AI-perfect features.`
    : '';

  // Layout pr konsepttype
  let layoutBlock;
  switch (concept.type) {
    case 'renTekst':
      layoutBlock =
`LAYOUT — PURE TYPOGRAPHY (concept 1, "renTekst"): no photograph. The composition is entirely typography on flat brand color. Background is ${cust.primer}. Hook in two large lines in ${cust.font || 'sans-serif'}-style, ${cust.sekunder}, with the keyword "${concept.hook_nokkelord || ''}" in ${cust.aksent}. ${rolleLinje ? `Below the hook, a small role line in ${cust.sekunder}: ${rolleLinje}.` : ''} Three short bullet points (each with a small ${cust.aksent} dot) in ${cust.sekunder}: ${punkter.join(' / ')}. Solid ${cust.aksent} rounded CTA button with ${cust.sekunder} uppercase "SØK NÅ" text and small ${cust.sekunder} URL "${cust.url}". Strict, editorial, minimal decoration.`;
      break;
    case 'foto':
      layoutBlock =
`LAYOUT — PHOTO-DOMINANT ("foto"): a large real photograph fills the upper ~60% of the safe zone, framed with softly rounded corners. Hook sits over the photo in a dark gradient strip at the bottom of the photo block, in ${cust.sekunder} with "${concept.hook_nokkelord || ''}" in ${cust.aksent}. ${rolleLinje ? `Role line "${rolleLinje}" below the photo.` : ''} Below: three small bullets in ${cust.sekunder} (${punkter.join(' / ')}), then the ${cust.aksent} CTA button "SØK NÅ" with URL ${cust.url}. The photo is the star.`;
      break;
    case 'fordeler':
      layoutBlock =
`LAYOUT — BENEFITS HERO ("fordeler"): the three bullet points are the biggest typographic elements, treated as stacked color bands or oversized number-cards (01, 02, 03 in ${cust.aksent}). Bullets: ${punkter.join(' / ')}. Hook above as a short headline in ${cust.font || 'sans-serif'}-style. ${rolleLinje ? `Small role line: ${rolleLinje}.` : ''} CTA at bottom (${cust.aksent} solid, "SØK NÅ", URL ${cust.url}). Mostly typographic — minimal or no photo.`;
      break;
    case 'spørsmål':
      layoutBlock =
`LAYOUT — QUESTION HOOK ("spørsmål"): top half is a large two-line question directly addressing the candidate, set in ${cust.font || 'sans-serif'}-style ${cust.sekunder} on ${cust.primer}, with the key word "${concept.hook_nokkelord || ''}" in ${cust.aksent}. Bottom half: smaller framed image (real photo if available), bullets ${punkter.join(' / ')}, ${rolleLinje ? `role line ${rolleLinje},` : ''} and CTA button "SØK NÅ" with URL ${cust.url}.`;
      break;
    case 'premium':
      layoutBlock =
`LAYOUT — PREMIUM EDITORIAL ("premium"): refined magazine-feature style. Generous whitespace, hook set in small-caps ${cust.font || 'serif'}-style, ${cust.sekunder} on ${cust.primer}. Thin ${cust.aksent} dividers between sections. Bullets ${punkter.join(' / ')} treated as elegant lead-in lines, not dot points. ${rolleLinje ? `Small role line: ${rolleLinje}.` : ''} Subtle ${cust.aksent} CTA "SØK NÅ" with URL ${cust.url}. Sophisticated, never loud.`;
      break;
    default:
      layoutBlock = `LAYOUT (${concept.type}): ${concept.layout || 'vertical editorial recruitment ad layout matching the concept brief'}.`;
  }

  // Visuell blokk — bruk eksisterende ekte bilde, eller generer.
  const visualBlock = concept.visual?.mode === 'bruk_bilde'
    ? `VISUAL: USE the provided photograph as the hero image — keep it real and UNALTERED. Build the design around it. Do not re-render or modify the person/scene.`
    : `VISUAL: ${concept.visual?.generer_beskrivelse || 'a realistic relevant scene supporting the headline'}.\n\n${realismBlock}`;

  // Tving brand-farger-bruk
  const fargebrukLine = concept.fargebruk ? `Brand color application for this concept: ${concept.fargebruk}.` : '';

  // Tekst som MÅ gjengis bokstavelig
  const exactTextParts = [
    ...(willCompositeLogo ? [] : [cust.merke]),
    'VI SØKER',
    hookWhole,
    ...(rolleLinje ? [rolleLinje] : []),
    ...punkter,
    'SØK NÅ',
    ...(cust.url ? [cust.url] : []),
  ].filter(Boolean);

  return `A complete, finished vertical recruitment job advertisement (Norwegian stillingsannonse),
9:16 format, 1088x1920, fully designed and publish-ready with text, layout and branding baked in.
Premium editorial poster, on-brand for ${cust.merke}.
CONCEPT TYPE: ${concept.type}.

${layoutBlock}

${visualBlock}

${logoBlock}

COLORS: ${fargerLinje}. ${fargebrukLine}
TONE: ${cust.stemme || 'warm, direct, honest — no clichés, no corporate fluff'}.

SAFE ZONE (critical): keep ALL text, the CTA button, the wordmark/logo area, and the focal subject within the centered safe area between y=285 and y=1635. The top strip (y=0–285) and the bottom strip (y=1635–1920) must contain ONLY background and atmosphere — never text, button or logo. The "SØK NÅ" button sits well inside the safe zone, never near the bottom edge (Meta's UI covers the lowest ~20%).

CRITICAL — render this text EXACTLY and spelled correctly, including å and ø:
${exactTextParts.join(', ')}. No other text, no lorem ipsum, no extra words, no watermark, no misspellings.

Vertical 9:16 finished job ad; all text and CTA strictly inside safe zone y=285–1635; empty top and bottom strips; all Norwegian text correctly spelled with å and ø; publish-ready.`;
}

// Logo-compositing: legg ekte logo-PNG oppå det ferdige bildet. Posisjon og
// størrelse varierer per konsepttype (LOGO_PLACEMENT). Safe zone er y=285..1635
// (av 1920) — logoen skal alltid ligge innenfor.
async function compositeLogoOnAd(adBuffer, logoBuffer, placement = DEFAULT_LOGO_PLACEMENT) {
  const { default: sharp } = await import('sharp');
  const adMeta = await sharp(adBuffer).metadata();
  const adW = adMeta.width  || 1088;
  const adH = adMeta.height || 1920;

  const logoWidthTarget = Math.round(adW * (placement.bredeProsent / 100));
  const resized = await sharp(logoBuffer)
    .resize({ width: logoWidthTarget, withoutEnlargement: false })
    .png()
    .toBuffer();
  const resizedMeta = await sharp(resized).metadata();
  const logoW = resizedMeta.width  || logoWidthTarget;
  const logoH = resizedMeta.height || logoWidthTarget;

  // Safe-zone-grenser i piksler (på 1920 høyde: y=285..1635).
  const safeTop    = Math.round(adH * (285 / 1920));
  const safeBottom = Math.round(adH * (1635 / 1920));
  const sideMargin = Math.round(adW * 0.07);
  const padding    = Math.round(adH * 0.02); // litt luft fra safe-zone-kanten

  let top, left;
  if (placement.posisjon.startsWith('topp'))      top = safeTop + padding;
  else if (placement.posisjon.startsWith('bunn')) top = safeBottom - logoH - padding;
  else /* midten */                                top = Math.round((adH - logoH) / 2);

  if (placement.posisjon.endsWith('venstre'))      left = sideMargin;
  else if (placement.posisjon.endsWith('høyre'))   left = adW - logoW - sideMargin;
  else /* senter */                                 left = Math.round((adW - logoW) / 2);

  return await sharp(adBuffer)
    .composite([{ input: resized, left, top }])
    .png()
    .toBuffer();
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5 — generer 5 annonser (én per konsept), n=1, komponere logo om mulig
// ─────────────────────────────────────────────────────────────────────────────
async function generateOneAd({ concept, conceptIndex, job, cust, checklist, assets }) {
  const willCompositeLogo = !!(concept.bruk_logo && assets.logoFil?.buffer);
  const logoPlacement = LOGO_PLACEMENT[concept.type] || DEFAULT_LOGO_PLACEMENT;
  const prompt = buildConceptPrompt(concept, { cust, job, checklist, willCompositeLogo, logoPlacement });

  const common = { model: IMAGE_MODEL, prompt, size: IMAGE_SIZE, quality: IMAGE_QUALITY, n: 1 };
  let buffer;
  let visualSource;
  if (concept.visual?.mode === 'bruk_bilde' && assets.brukbareEkteBilder[concept.visual.bilde_indeks]) {
    const photo = assets.brukbareEkteBilder[concept.visual.bilde_indeks];
    const ext = (photo.mediaType || 'image/png').split('/')[1] || 'png';
    const resp = await openai.images.edit({
      ...common,
      image: await toFile(photo.buffer, `reference.${ext}`, { type: photo.mediaType || 'image/png' }),
    });
    buffer = Buffer.from(resp.data[0].b64_json, 'base64');
    visualSource = `bilde[${concept.visual.bilde_indeks}] (${photo.source})`;
  } else {
    const resp = await openai.images.generate(common);
    buffer = Buffer.from(resp.data[0].b64_json, 'base64');
    visualSource = 'AI-generert';
  }

  let logoComposited = false;
  if (willCompositeLogo) {
    buffer = await compositeLogoOnAd(buffer, assets.logoFil.buffer, logoPlacement);
    logoComposited = true;
  }

  return { conceptIndex, concept, buffer, visualSource, logoComposited, logoPlacement: willCompositeLogo ? logoPlacement.posisjon : null };
}

async function generateFiveAds({ concepts, job, cust, checklist, assets }) {
  // Parallelt — totaltid ≈ tiden for den treigeste enkeltgenereringen.
  // OBS: OpenAI Tier 1 har 5 images/min; treffer vi grensen kaster vi videre.
  console.log(`   Starter ${concepts.length} parallelle GPT Image 2-kall...`);
  const tasks = concepts.map((concept, i) =>
    generateOneAd({ concept, conceptIndex: i, job, cust, checklist, assets })
      .then((ad) => {
        const logoNote = ad.logoComposited ? ` + logo composited (${ad.logoPlacement})` : '';
        console.log(`     ✓ ${i + 1}/${concepts.length} [${concept.type}] ${ad.visualSource}${logoNote}`);
        return ad;
      })
  );
  const ads = await Promise.all(tasks);
  // Bevar konseptrekkefølgen i utfilene (renTekst først osv.)
  return ads.sort((a, b) => a.conceptIndex - b.conceptIndex);
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 6 — navngiving (§ 11 + type-token), lagring og publisering
// ─────────────────────────────────────────────────────────────────────────────
function camel(s) {
  return s.replace(/[^a-zA-ZæøåÆØÅ ]/g, '').split(/\s+/).slice(0, 3)
    .map((w, i) => i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
}
function imageBaseName({ cust, job }) {
  const kode  = (cust.kode || 'XX').toUpperCase();
  const rolle = (job.tittel.split(/[\s–-]/)[0] || 'ROLLE').toUpperCase();
  const vinkel = camel(job.vinkel) || 'Vinkel';
  return `${kode}-${rolle}-${vinkel}`;
}
function suffixFor(i) {
  return String(i + 1).padStart(2, '0'); // 01, 02, ..., 05
}
function adFileName({ base, concept, index }) {
  const typeToken = TYPE_TOKEN[concept.type] || 'Annonse';
  return `${base}-${typeToken}-${suffixFor(index)}.png`;
}

async function saveAds(ads, { cust, job }) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const base = imageBaseName({ cust, job });
  const files = [];
  for (let i = 0; i < ads.length; i++) {
    const filename = adFileName({ base, concept: ads[i].concept, index: i });
    const file = path.join(OUTPUT_DIR, filename);
    await fs.writeFile(file, ads[i].buffer);
    files.push(file);
  }
  return files;
}

async function publishToNotion(ads, { cust, job }) {
  const base = imageBaseName({ cust, job });
  const uploaded = [];
  for (let i = 0; i < ads.length; i++) {
    const filename = adFileName({ base, concept: ads[i].concept, index: i });
    const upload = await notion.fileUploads.create({
      filename,
      content_type: 'image/png',
    });
    await notion.fileUploads.send({
      file_upload_id: upload.id,
      file: { filename, data: new Blob([ads[i].buffer], { type: 'image/png' }) },
    });
    uploaded.push({ id: upload.id, name: filename });
  }
  await notion.pages.update({
    page_id: job.pageId,
    properties: {
      [NOTION_OUTPUT_FILE_COL]: {
        files: uploaded.map((u) => ({
          name: u.name,
          type: 'file_upload',
          file_upload: { id: u.id },
        })),
      },
      Status: { select: { name: STATUS_DONE } },
    },
  });
  return uploaded.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrate
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`→ Looking for a job marked "${STATUS_READY}"...`);
  const jobPage = await findReadyJob();
  if (!jobPage) { console.log('   Ingen jobber klare akkurat nå.'); return false; }

  const { job, cust } = await readJobAndCustomer(jobPage);
  console.log(`→ ${cust.merke}: ${job.tittel} (${job.type} · ${job.sted})`);
  console.log(`   Branding-kilde: ${cust.kilde}`);
  console.log(`   Fargekilde: ${cust.fargerKilde} (${cust.alle.length} hex)`);
  console.log(`   Bilder: jobb=${job.jobbPhotoUrls.length}, bibliotek=${cust.bildebibliotekUrls.length}, logo=${cust.logoUrls.length}`);

  const totalToAnalyze = job.jobbPhotoUrls.length + cust.bildebibliotekUrls.length;
  if (totalToAnalyze + cust.logoUrls.length > 0) {
    console.log(`→ Analyserer ${totalToAnalyze} bilde(r) med vision + henter ${cust.logoUrls.length} logo(er)...`);
  } else {
    console.log('→ Ingen opplastede bilder å analysere.');
  }
  const assets = await analyzeAssets({ job, cust });
  console.log(`   Brukbare ekte bilder: ${assets.brukbareEkteBilder.length} / ${totalToAnalyze}`);
  console.log(`   Logo funnet: ${assets.logoFil ? 'ja' : 'nei'}`);
  for (const a of assets.alle) {
    if (a.feil) console.log(`   ⚠ ${a.source}: ${a.feil}`);
    else if (a.analyse) console.log(`   [${a.source}] ${a.analyse.type}/${a.analyse.kvalitet}: ${a.analyse.hva}`);
  }

  const checklist = buildChecklist({ job, cust, assets });
  const positiveFlags = Object.entries(checklist)
    .filter(([k, v]) => k.startsWith('har') && v === true)
    .map(([k]) => k.replace(/^har/, ''));
  console.log(`→ Sjekkliste (ja): ${positiveFlags.join(', ') || '(ingen)'}`);
  console.log(`   Regler: ansettelsestype i ≥${checklist.regler.ansettelsestypeMinstAntall}, lokasjon i ≥${checklist.regler.lokasjonMinstAntall}, farger=${checklist.regler.fargerIAlle}, logo=${checklist.regler.logoIAlle}, ekte-bilde-prioritet=${checklist.regler.foretrekkEkteBildeOverGenerering}`);

  console.log('→ Planlegger 5 konsepter med Claude...');
  const concepts = await planFiveAds({ job, cust, assets, checklist });
  concepts.forEach((c, i) => {
    const visual = c.visual?.mode === 'bruk_bilde' ? `bilde[${c.visual.bilde_indeks}]` : 'generer';
    console.log(`     ${i + 1}. [${c.type}] "${c.hook_hele}" — ${visual} — logo=${c.bruk_logo}`);
  });

  console.log(`→ Genererer ${concepts.length} annonser med GPT Image 2 (parallelt)...`);
  const ads = await generateFiveAds({ concepts, job, cust, checklist, assets });

  const files = await saveAds(ads, { cust, job });
  console.log(`→ Saved ${files.length} ad(s) locally:`);
  files.forEach((f) => console.log(`   ${f}`));

  console.log(`→ Publiserer til Notion (${NOTION_OUTPUT_FILE_COL} + status → ${STATUS_DONE})...`);
  const uploaded = await publishToNotion(ads, { cust, job });
  console.log(`   ${uploaded} fil(er) festet til jobben.`);
  console.log(`→ Done: "${job.tittel}".`);
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollLoop() {
  const minutes = POLL_INTERVAL_MS / 60000;
  console.log(`Polling Notion hvert ${minutes} min for jobber med status "${STATUS_READY}". Ctrl+C for å stoppe.\n`);
  for (;;) {
    try {
      // Tøm køen — kjør så lenge det finnes flere jobber klar.
      while (await main()) { /* fortsett umiddelbart hvis det var én til */ }
    } catch (err) {
      console.error('✖ Feil under kjøring:', err.message);
    }
    console.log(`⏳ Venter ${minutes} min før neste sjekk...\n`);
    await sleep(POLL_INTERVAL_MS);
  }
}

// I CI/Actions kjører cron-jobben skriptet hvert 5. min — da vil vi bare gjøre
// ÉN runde og avslutte. Lokalt vil vi pollee i en evig løkke.
if (process.env.RUN_ONCE === 'true') {
  (async () => {
    try {
      // Tøm køen i én cron-fyring — hvis flere "Levert"-jobber, prosesser alle.
      while (await main()) { /* fortsett */ }
    } catch (err) {
      console.error('✖ Feil:', err.message);
      process.exit(1);
    }
  })();
} else {
  pollLoop();
}
