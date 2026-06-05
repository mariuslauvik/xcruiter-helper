// Xcruiter ad helper — v0.4 (3 minimalistiske annonser per kjøring)
//
// Layout matcher executive recruitment-style samples (Maarud / Nasjonalarkivet / CAPUS):
//   • Fargepanel topp (50%): logo + "Vi søker"-pill + stillingstittel + valgfri undertittel
//   • Fullbredde ekte foto bunn (50%) — ingen CTA, ingen bullets, ingen URL.
//
// Flow:
//   1. Finn første jobb i Stillinger med Status = "Levert".
//   2. Les jobb (inkl. Nettsted og Brand farger) + slå opp kunde.
//      Les ALLE filer i jobbens "Bilder til annonse" og kundens Bildebibliotek/Logo.
//   3. scrapeWebsiteAssets() hvis Nettsted satt: HTTP-fetch + regex-parse for farger,
//      font og bilder (HTML-statisk; SPA-sider faller tilbake til defaults).
//   4. resolveBranding(): Kunde > Brand farger > Nettsted-skrap > defaults.
//   5. analyzeAssets(): Claude vision per bilde (jobb + bibliotek + nettsted).
//   6. buildChecklist(): boolean-flagg som styrer prompt.
//   7. planThreeAds(): ett Claude-kall returnerer 3 varianter (samme template,
//      ulikt foto + evt. liten undertittel-variasjon).
//   8. generateThreeAds(): én GPT Image 2-genereringer per variant, parallelt.
//      Ekte brukbart bilde → images.edit; ellers images.generate.
//      Logo composites top-center via sharp (samme plassering på alle 3).
//   9. saveAds() lokalt + publishToNotion() fester alle 3 til "Annonser"
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

// Filnavn-token er nå bare et indeksnummer (alle 3 varianter har samme template).

// To-panel-template: logoen ligger i toppen av safe zone, sentrert. Samme
// plassering på alle 3 varianter for konsistent merkeidentitet.
// Krymper til 14% for å unngå overlap med "Vi søker"-pill rett under.
const LOGO_PLACEMENT = {
  posisjon: 'topp-senter',
  bredeProsent: 14,
  beskrivelse: 'centered horizontally near the top of the colored panel',
};

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

// WCAG-stil relativ luminans og kontrast — brukes til å sikre at panel-farge
// (primer) og tekst-farge (sekunder) er lesbare sammen.
function rgbFromHex(hex) {
  const m = String(hex || '').match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function relativeLuminance(hex) {
  const rgb = rgbFromHex(hex);
  if (!rgb) return 0.5;
  const ch = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch(rgb.r) + 0.7152 * ch(rgb.g) + 0.0722 * ch(rgb.b);
}
function contrastRatio(a, b) {
  const La = relativeLuminance(a), Lb = relativeLuminance(b);
  const hi = Math.max(La, Lb), lo = Math.min(La, Lb);
  return (hi + 0.05) / (lo + 0.05);
}
// Sikrer at primer (panel) og sekunder (tekst) har kontrast ≥ 4.5 (WCAG AA).
// Hvis ikke: prøv først å bytte roller, deretter overstyr sekunder til
// en trygg lys/mørk verdi avhengig av panel-luminansen.
function ensureColorContrast(cust) {
  const MIN = 4.5;
  const DARK_TEXT  = '#1A1A1A';
  const LIGHT_TEXT = '#F5F1E8';

  let kontrast = contrastRatio(cust.primer, cust.sekunder);
  if (kontrast >= MIN) return { ok: true, kontrast, justert: null };

  // 1) Bytte roller hvis sekunder er klart mørkere/lysere enn primer
  //    (begge er kandidater til panel/tekst — bare velg riktig rolle).
  const Lp = relativeLuminance(cust.primer);
  const Ls = relativeLuminance(cust.sekunder);
  if (Math.abs(Lp - Ls) >= 0.4) {
    [cust.primer, cust.sekunder] = [cust.sekunder, cust.primer];
    kontrast = contrastRatio(cust.primer, cust.sekunder);
    if (kontrast >= MIN) return { ok: true, kontrast, justert: 'byttet primer↔sekunder' };
  }

  // 2) Overstyr sekunder til trygg kontrastfarge basert på panel-luminans.
  const panelLum = relativeLuminance(cust.primer);
  cust.sekunder = panelLum > 0.4 ? DARK_TEXT : LIGHT_TEXT;
  kontrast = contrastRatio(cust.primer, cust.sekunder);
  return { ok: kontrast >= MIN, kontrast, justert: `sekunder → ${cust.sekunder}` };
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
    soknadsfrist:  txt(jp['Søknadsfrist']),
    brandFargerRaw:txt(jp['Brand farger']),       // tekst-fallback fargekilde
    nettsted:      txt(jp['Nettsted']),           // URL — skrapes for branding/bilder hvis satt
    dittFirma:     txt(jp['Ditt firma']),
    font:          txt(jp['Font']),               // per-jobb override (legges til av bruker)
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
  // Initial fargekilde-merking; resolveBranding kan overskrive med Nettsted-skrap.
  cust.fargerKilde = cust.alle.length > 0 ? 'kundens Merkevarefarger' : 'ikke satt';
  cust.fontKilde   = cust.font ? 'kundens Font' : 'ikke satt';
  return { job, cust };
}

// Setter sammen endelig branding-presedens. Kalles fra main() etter at både
// Kunder-rad og evt. nettsted er hentet.
// SPEC v3 §a-rekkefølge: stillingens "Brand farger" > Kunders Merkevarefarger
// > Nettsted-skrap > defaults. ensureColorContrast er obligatorisk siste steg.
function resolveBranding({ cust, job, scraped }) {
  // Hva Kunder-raden allerede ga oss via buildCustFromPage
  const fraKunde = cust.alle.length > 0
    ? { alle: cust.alle, primer: cust.primer, sekunder: cust.sekunder, aksent: cust.aksent }
    : null;

  // Nullstill til defaults og bygg opp via presedens
  const def = parseColors('');
  cust.alle = []; cust.primer = def.primer; cust.sekunder = def.sekunder; cust.aksent = def.aksent;
  cust.fargerKilde = 'defaults';

  // 1) Stillingens "Brand farger" vinner
  if (job.brandFargerRaw) {
    const c = parseColors(job.brandFargerRaw);
    if (c.alle.length > 0) {
      cust.alle = c.alle; cust.primer = c.primer; cust.sekunder = c.sekunder; cust.aksent = c.aksent;
      cust.fargerKilde = 'stillingens "Brand farger"';
    }
  }
  // 2) Kunders Merkevarefarger
  if (cust.alle.length === 0 && fraKunde) {
    cust.alle = fraKunde.alle;
    cust.primer = fraKunde.primer; cust.sekunder = fraKunde.sekunder; cust.aksent = fraKunde.aksent;
    cust.fargerKilde = 'kundens Merkevarefarger';
  }
  // 3) Nettsted-skrap
  if (cust.alle.length === 0 && scraped?.colors?.length > 0) {
    const c = parseColors(scraped.colors.join(' '));
    cust.alle = c.alle; cust.primer = c.primer; cust.sekunder = c.sekunder; cust.aksent = c.aksent;
    cust.fargerKilde = `nettsted (${scraped.url})`;
  }

  // Font-presedens: stillingens Font > Kunders Font > scraped > Poppins (default).
  // Stillingens Font har høyest prioritet — brukeren kan overstyre per-jobb.
  if (job.font) {
    cust.font = job.font;
    cust.fontKilde = 'stillingens Font';
  } else if (cust.font) {
    // beholdt fra buildCustFromPage — kommer fra Kunders Font
    cust.fontKilde = 'kundens Font';
  } else if (scraped?.font) {
    cust.font = scraped.font;
    cust.fontKilde = `nettsted (${scraped.url})`;
  } else {
    cust.font = 'Poppins';
    cust.fontKilde = 'default (Poppins)';
  }

  // Kontrast-vakt MÅ kjøre — hindrer gull-på-hvit, hvit-på-hvit, etc.
  const kontrast = ensureColorContrast(cust);
  cust.kontrast = kontrast;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2a — skrap branding fra Nettsted (§ B)
// HTTP-fetch + regex-parse for farger, font og bilder. Lett-vekt: ingen
// headless browser, ingen ny dependency. SPA-sider faller tilbake til defaults.
// ─────────────────────────────────────────────────────────────────────────────
function decodeHtmlEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2f;/gi, '/')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCharCode(parseInt(c, 16)));
}

function hexFromColorString(s) {
  if (!s) return null;
  s = String(s).trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return '#' + s.slice(1).split('').map((c) => c + c).join('');
  if (/^#[0-9a-f]{8}$/.test(s)) return s.slice(0, 7); // dropp alpha
  const rgb = s.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (rgb) return '#' + [rgb[1], rgb[2], rgb[3]].map((n) => parseInt(n).toString(16).padStart(2, '0')).join('');
  return null;
}

function extractColorsFromHtml(html) {
  const colors = new Set();
  // <meta name="theme-color">
  const themeMatch = html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i);
  const themeHex = themeMatch && hexFromColorString(themeMatch[1]);
  if (themeHex) colors.add(themeHex);
  // CSS custom properties — typiske brand-tokens
  const cssVarRe = /--(?:primary|brand|color|accent|main|secondary|background|bg|text|fg|theme)[a-z0-9_-]*\s*:\s*([^;}\n]+)/gi;
  for (const m of html.matchAll(cssVarRe)) {
    const hex = hexFromColorString(m[1]);
    if (hex) colors.add(hex);
  }
  // Hex-koder i <style>-blokker (samler første 5 unike)
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const hexInStyles = styleBlocks.match(/#[0-9a-f]{6}\b/gi) || [];
  for (const h of hexInStyles.slice(0, 20)) {
    const hex = hexFromColorString(h);
    if (hex) colors.add(hex);
    if (colors.size >= 8) break;
  }
  return [...colors].slice(0, 8);
}

function extractFontFromHtml(html) {
  // Google Fonts-lenke er sterkeste signalet
  const gfont = html.match(/fonts\.googleapis\.com\/css2?\?family=([^&"'>\s]+)/i);
  if (gfont) return decodeURIComponent(gfont[1].replace(/\+/g, ' ').split(':')[0]);
  // font-family-deklarasjoner — første konkrete navn
  const ffRe = /font-family\s*:\s*['"]?([^'";}\n]+?)['"]?\s*[;}]/gi;
  for (const m of html.matchAll(ffRe)) {
    const first = m[1].split(',')[0].replace(/['"`]/g, '').trim();
    if (!first) continue;
    const lower = first.toLowerCase();
    if (['inherit', 'initial', 'unset', 'sans-serif', 'serif', 'monospace', 'system-ui'].includes(lower)) continue;
    if (lower.startsWith('var(')) continue;
    return first;
  }
  return null;
}

// Hjelper: HTML-attributter inneholder ofte HTML-entities (&amp;, &#x2F; osv.)
// — disse må dekodes FØR URL-parsing, ellers blir Next.js og lignende
// proxy-URL-er ugyldige (f.eks. ?url=...&amp;w=3840 må bli ?url=...&w=3840).
function toAbsUrl(raw, baseUrl) {
  if (!raw) return null;
  const decoded = decodeHtmlEntities(raw.trim());
  if (!decoded || decoded.startsWith('data:')) return null;
  try { return new URL(decoded, baseUrl).toString(); } catch { return null; }
}

function extractLogoUrlsFromHtml(html, baseUrl) {
  const urls = [];
  const imgRe = /<img\b[^>]*>/gi;
  for (const m of html.matchAll(imgRe)) {
    const tag = m[0];
    if (!/\b(logo|mark|brand|wordmark)\b/i.test(tag)) continue;
    const src = (tag.match(/(?:^|\s)(?:src|data-src)=["']([^"']+)["']/i) || [])[1];
    const u = toAbsUrl(src, baseUrl);
    if (u) urls.push(u);
  }
  for (const m of html.matchAll(/<link[^>]+rel=["']apple-touch-icon[^"']*["'][^>]+href=["']([^"']+)["']/gi)) {
    const u = toAbsUrl(m[1], baseUrl); if (u) urls.push(u);
  }
  for (const m of html.matchAll(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/gi)) {
    if (!/\.ico(\?|$)/i.test(m[1])) {
      const u = toAbsUrl(m[1], baseUrl); if (u) urls.push(u);
    }
  }
  return [...new Set(urls)];
}

function extractContentImageUrlsFromHtml(html, baseUrl) {
  const urls = new Set();
  const looksLikeAsset = (s) => /\b(logo|mark|brand|wordmark|icon|favicon|sprite|avatar|emoji|spinner|loader)\b/i.test(s);
  const skipExt = (s) => /\.(svg|gif|ico)(\?|$)/i.test(s);

  const imgRe = /<img\b[^>]*>/gi;
  for (const m of html.matchAll(imgRe)) {
    const tag = m[0];
    if (looksLikeAsset(tag)) continue;
    const src = (tag.match(/(?:^|\s)(?:src|data-src)=["']([^"']+)["']/i) || [])[1];
    if (src && !skipExt(src)) {
      const u = toAbsUrl(src, baseUrl); if (u) urls.add(u);
    }
    const srcset = (tag.match(/srcset=["']([^"']+)["']/i) || [])[1];
    if (srcset) {
      const decoded = decodeHtmlEntities(srcset);
      const parts = decoded.split(',').map((p) => p.trim().split(/\s+/));
      const best = parts.sort((a, b) => parseInt(b[1] || '0') - parseInt(a[1] || '0'))[0]?.[0];
      if (best && !skipExt(best)) {
        const u = toAbsUrl(best, baseUrl); if (u) urls.add(u);
      }
    }
  }
  for (const m of html.matchAll(/background(?:-image)?\s*:[^;}]*url\(\s*["']?([^)"']+)["']?\s*\)/gi)) {
    const raw = m[1];
    if (raw && !looksLikeAsset(raw) && !skipExt(raw)) {
      const u = toAbsUrl(raw, baseUrl); if (u) urls.add(u);
    }
  }
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (og) { const u = toAbsUrl(og[1], baseUrl); if (u) urls.add(u); }
  return [...urls].slice(0, 25);
}

async function scrapeWebsiteAssets(rawUrl, opts = {}) {
  const { maxImages = 3, minImageBytes = 20000 } = opts;
  if (!rawUrl) return null;

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`).toString();
  } catch {
    return { url: rawUrl, colors: [], font: null, logoFile: null, images: [], feil: 'ugyldig URL' };
  }

  let html;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; XcruiterAdHelper/0.4; +https://github.com/mariuslauvik/xcruiter-helper)',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });
    if (!res.ok) return { url, colors: [], font: null, logoFile: null, images: [], feil: `HTTP ${res.status}` };
    html = await res.text();
  } catch (err) {
    return { url, colors: [], font: null, logoFile: null, images: [], feil: `fetch: ${err.message}` };
  }

  const colors = extractColorsFromHtml(html);
  const font   = extractFontFromHtml(html);

  // Logo: last ned ALLE kandidater (opp til 5). Vision-bekrefter mot selskapet
  // i analyzeAssets — vi stoler ikke på første nedlastbare før vi vet at det
  // faktisk er logoen til dette firmaet.
  const logoUrls = extractLogoUrlsFromHtml(html, url);
  const logoCandidates = [];
  for (const u of logoUrls.slice(0, 5)) {
    try {
      const { buffer, mediaType } = await fetchImageAsBuffer(u);
      if (buffer.length < 1000) continue;
      logoCandidates.push({ url: u, buffer, mediaType });
    } catch { /* hopp over */ }
  }
  const logoFile = null; // beholdt for BC; analyzeAssets velger riktig kandidat

  // Content-bilder: last ned kandidater, filtrer ut små.
  const contentUrls = extractContentImageUrlsFromHtml(html, url);
  const images = [];
  let triedCount = 0;
  let tooSmallCount = 0;
  let downloadFailCount = 0;
  for (const u of contentUrls) {
    if (images.length >= maxImages) break;
    if (logoFile && u === logoFile.url) continue;
    triedCount++;
    try {
      const { buffer, mediaType } = await fetchImageAsBuffer(u);
      if (buffer.length < minImageBytes) { tooSmallCount++; continue; }
      images.push({ url: u, buffer, mediaType, source: 'nettsted' });
    } catch {
      downloadFailCount++;
    }
  }

  return {
    url, colors, font, logoFile, logoCandidates, images,
    debug: { logoKandidater: logoUrls.length, logoLastetNed: logoCandidates.length, contentKandidater: contentUrls.length, prøvd: triedCount, forSmaa: tooSmallCount, feilet: downloadFailCount },
    feil: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2a' — researchCompany via Anthropic web_search (SPEC v3 §d)
// Beriker konteksten med bransje/hva-de-gjør/målgruppe/tone — overstyrer ALDRI
// det kunden faktisk har lagt inn. Returnerer null hvis usikker (sikkerhet=lav).
// ─────────────────────────────────────────────────────────────────────────────
async function researchCompany({ navn, nettsted, sted }) {
  if (!navn) return null;
  try {
    const msg = await anthropic.messages.create({
      model: COPY_MODEL,
      max_tokens: 1024,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      messages: [{
        role: 'user',
        content:
          `Søk på nettet etter firmaet "${navn}"` +
          `${nettsted ? ` (nettsted: ${nettsted})` : ''}` +
          `${sted ? `, sted: ${sted}` : ''}. ` +
          `Returner KUN rå JSON, ingen markdown, ingen forklaring:\n` +
          `{"bransje":"<kort, f.eks. 'fintech', 'restaurant'>",` +
          `"hva_de_gjør":"<én setning>",` +
          `"målgruppe":"<hvem de selger til / jobber for>",` +
          `"tone":"<formell|profesjonell|varm|teknisk|kreativ|annet>",` +
          `"sikkerhet":"høy|lav"}\n` +
          `Sett sikkerhet="lav" hvis du er usikker på at det er riktig firma — da ignoreres svaret.`,
      }],
    });
    const textBlock = msg.content.filter((b) => b.type === 'text').pop();
    if (!textBlock?.text) return null;
    const raw = textBlock.text.trim().replace(/^```json\s*|\s*```$/g, '');
    const result = JSON.parse(raw);
    if (result.sikkerhet === 'lav') return { ...result, ignored: true };
    return result;
  } catch (err) {
    return { feil: err.message };
  }
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

async function analyzeImageData({ buffer, mediaType, url, source }) {
  try {
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

async function analyzeOneImage(url, source) {
  try {
    const { buffer, mediaType } = await fetchImageAsBuffer(url);
    return await analyzeImageData({ buffer, mediaType, url, source });
  } catch (err) {
    return { url, source, buffer: null, mediaType: null, analyse: null, feil: err.message };
  }
}

// Vision-verifisering: er DETTE bildet logoen til DETTE selskapet?
// Brukes på scraped logo-kandidater. Claude vurderer både bokstavelig
// tekstmatch og initialer/monogrammer (f.eks. "LM" kan være "Lauvico AS").
async function verifyLogoMatch({ buffer, mediaType, url, merke }) {
  try {
    const msg = await anthropic.messages.create({
      model: COPY_MODEL,
      max_tokens: 250,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } },
          { type: 'text', text:
            `Se på bildet og vurder om det kan være logoen til selskapet "${merke}". ` +
            `Tenk på bokstavelige tekstmatcher, initialer/monogrammer (f.eks. "LM" kan være ` +
            `forkortelse for "Lauvico AS"), og visuelle merkesymboler. Returner KUN rå JSON, ingen markdown:\n` +
            `{"er_logo":true|false,"er_dette_logoen":true|false,"sikkerhet":"høy|middels|lav",` +
            `"tekst_i_bildet":"<eksakt tekst du leser, eller tom>",` +
            `"begrunnelse":"<kort hvorfor du sa ja/nei>"}`,
          },
        ],
      }],
    });
    const raw = msg.content[0].text.trim().replace(/^```json\s*|\s*```$/g, '');
    const r = JSON.parse(raw);
    const match = r.er_logo === true && r.er_dette_logoen === true && r.sikkerhet !== 'lav';
    return {
      url, source: 'nettsted-logo', buffer, mediaType,
      analyse: {
        type: r.er_logo ? 'logo' : 'annet',
        brukbar_som_annonsebilde: false,
        kvalitet: r.sikkerhet || 'middels',
        hva: r.tekst_i_bildet ? `logo med tekst "${r.tekst_i_bildet}"` : 'logo uten lesbar tekst',
        notat: r.begrunnelse || '',
        match,
        tekst: r.tekst_i_bildet || '',
      },
      feil: null,
    };
  } catch (err) {
    return { url, source: 'nettsted-logo', buffer: null, mediaType: null, analyse: null, feil: err.message };
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

async function analyzeAssets({ job, cust, scrapedImages = [], scrapedLogoCandidates = [], merke = '' }) {
  const visionTasks = [
    ...job.jobbPhotoUrls.map((u) => analyzeOneImage(u, 'jobb')),
    ...cust.bildebibliotekUrls.map((u) => analyzeOneImage(u, 'bibliotek')),
    ...scrapedImages.map((img) => analyzeImageData({ buffer: img.buffer, mediaType: img.mediaType, url: img.url, source: 'nettsted' })),
  ];
  const logoTasks = cust.logoUrls.map(loadLogoOnly);

  // SPEC v3 §c + hardregel: vision-verifiserer HVER scraped logo-kandidat mot selskapet.
  // Bare "match=true"-resultater regnes som gyldig logo.
  const logoVerifyTasks = scrapedLogoCandidates.map((c) =>
    verifyLogoMatch({ buffer: c.buffer, mediaType: c.mediaType, url: c.url, merke })
  );

  const [analyserte, logoer, verifiedLogos] = await Promise.all([
    Promise.all(visionTasks),
    Promise.all(logoTasks),
    Promise.all(logoVerifyTasks),
  ]);

  // Plukk første kandidat hvor vision sa "ja, dette er logoen til {merke}"
  const scrapedLogoEntry = verifiedLogos.find((r) => r.analyse?.match === true) ?? null;

  // Avviste kandidater (er logo, men ikke vårt firma) → bare logges, kastes
  const avvisteLogos = verifiedLogos.filter((r) => r.analyse && !r.analyse.match);

  // Hvis en kandidat ikke var logo, kan den brukes som content
  for (const r of verifiedLogos) {
    if (r.analyse && r.analyse.type !== 'logo') {
      analyserte.push({ ...r, source: 'nettsted' });
    }
  }

  const alle = [...analyserte, ...logoer, ...(scrapedLogoEntry ? [scrapedLogoEntry] : []), ...avvisteLogos];

  // SPEC v3 §b — Bildehierarki:
  //  • Opplastede JOBB-bilder aksepteres ALLTID (utenom logo-routing) —
  //    kunden har lastet dem opp bevisst, vision beskriver bare.
  //  • Bibliotek/nettsted-bilder krever passende type + kvalitet.
  //  • Et opplastet jobb-bilde som flagges som logo rutes til logo-slot.
  const erBrukbarKategori = (t) => t === 'person' || t === 'arbeidsplass' || t === 'produkt';

  const jobbSomLogo = analyserte.find(
    (r) => r.source === 'jobb' && r.analyse?.type === 'logo' && !r.feil
  );

  const brukbareEkteBilder = analyserte.filter((r) => {
    const a = r.analyse;
    if (!a || a.type === 'logo') return false;
    if (r.source === 'jobb') return true;               // aldri avvis opplastet
    if (r.source === 'bibliotek' || r.source === 'nettsted') {
      return erBrukbarKategori(a.type) && a.kvalitet !== 'lav';
    }
    return false;
  });

  // Logo-presedens: Kunde Logo-kolonne > jobb-bilde flagget som logo
  // > scraped-logo > vision-flagget logo i andre kilder.
  let logoFil =
    logoer.find((r) => !r.feil) ??
    jobbSomLogo ??
    scrapedLogoEntry ??
    analyserte.find((r) => r.analyse?.type === 'logo' && r.source !== 'jobb' && !r.feil) ??
    null;

  // Siste fallback: hvis ingen logo funnet, kjør verifyLogoMatch på jobb-bilder.
  // Den generelle vision-analysen er content-fokusert og kan misse at et
  // jobb-uploadet bilde er logoen. Denne stiller spørsmålet direkte.
  if (!logoFil && merke) {
    const jobbBilder = analyserte.filter((r) => r.source === 'jobb' && !r.feil && r.buffer);
    for (const j of jobbBilder) {
      const verified = await verifyLogoMatch({
        buffer: j.buffer, mediaType: j.mediaType, url: j.url, merke,
      });
      if (verified.analyse?.match) {
        logoFil = { ...verified, source: 'jobb-uploadet-logo' };
        // Fjern fra brukbareEkteBilder så det ikke også brukes som hovedbilde
        const idx = brukbareEkteBilder.findIndex((b) => b.url === j.url);
        if (idx >= 0) brukbareEkteBilder.splice(idx, 1);
        break;
      }
    }
  }

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
// Step 3 — planlegg 3 annonse-varianter (§ D)
// Fast minimalistisk template (matcher Maarud/Nasjonalarkivet/CAPUS-samples).
// Variasjon: ulikt foto per ad. Undertittel er deterministisk (Ansettelsestype
// + evt. Lokasjon) — alle 3 deler samme undertittel.
// ─────────────────────────────────────────────────────────────────────────────
const AD_COUNT = 1; // testmodus — sett tilbake til 3 etter at scraping-piping er bekreftet

// SPEC v3 §e — Ansettelsestype alltid med, Lokasjon hvis satt.
function deriveUndertittel({ type, sted }) {
  if (type && sted) return `${type} · ${sted}`;
  if (type) return type;
  if (sted) return sted;
  return '';
}

async function planThreeAds({ job, cust, assets, checklist, researchContext = null }) {
  const bildeKatalog = assets.brukbareEkteBilder.length === 0
    ? '  (ingen brukbare ekte bilder — alle 3 må generere realistisk arbeidsplass-foto)'
    : assets.brukbareEkteBilder.map((b, i) =>
        `  [${i}] kilde=${b.source}, type=${b.analyse?.type}, kvalitet=${b.analyse?.kvalitet}, hva="${b.analyse?.hva}"`
      ).join('\n');

  const fargerLinje = checklist.harFarger
    ? `primær=${cust.primer}, sekundær=${cust.sekunder}, aksent=${cust.aksent}`
    : '(mangler — bruk nøytral premium-palett)';

  const system =
    'Du er en norsk reklametekstforfatter for stillingsannonser. Du planlegger 3 ' +
    'varianter av SAMME annonse i en fast minimalistisk template (fargepanel topp med ' +
    '"Vi søker"-pill + stillingstittel + valgfri undertittel + logo, fullbredde ekte foto ' +
    'i bunnen — ingen CTA, ingen punktliste, ingen URL). Variasjon skjer kun gjennom ' +
    'foto-valg og evt. en liten undertittel. ' +
    'Hovedtittelen er stillingstittel — endre den ikke. Korrekt å og ø overalt. ' +
    'Svar KUN med rå JSON-array, ingen markdown, ingen forklaring.';

  const researchBlock = researchContext
    ? `\nFIRMA-KONTEKST (fra web-søk — beriker, overstyrer ALDRI det kunden har lagt inn):\n` +
      `  Bransje: ${researchContext.bransje}\n` +
      `  Hva de gjør: ${researchContext.hva_de_gjør}\n` +
      `  Målgruppe: ${researchContext.målgruppe}\n` +
      `  Tone: ${researchContext.tone}\n`
    : '';

  const user =
    `MERKE: ${cust.merke}\n` +
    `FARGER: ${fargerLinje}\n` +
    `LOGO TILGJENGELIG: ${checklist.harLogo ? 'ja' : 'nei'}\n` +
    `\n` +
    `STILLING: ${job.tittel}\n` +
    `ANSETTELSESTYPE: ${job.type || '(ikke satt)'}\n` +
    `LOKASJON: ${job.sted || '(ikke satt)'}\n` +
    `VINKEL: ${job.vinkel || '(ikke satt)'}\n` +
    `BESKRIVELSE: ${job.beskrivelse || '(ikke satt)'}\n` +
    researchBlock +
    `\n` +
    `BRUKBARE EKTE BILDER (referer med bilde_indeks):\n${bildeKatalog}\n` +
    `\n` +
    `OPPGAVE: Lag NØYAKTIG ${AD_COUNT} varianter av annonsen.\n` +
    `\n` +
    `REGLER:\n` +
    `- "hovedtittel" SKAL være stillingstittel uendret: "${job.tittel}".\n` +
    `- "undertittel" settes deterministisk i koden ETTERPÅ — du kan returnere ` +
    `tom streng her; den blir uansett overstyrt med "${deriveUndertittel(job) || '(tom)'}".\n` +
    `- Foretrekk ekte bilder. Hvis det finnes ${AD_COUNT} eller flere brukbare bilder, ` +
    `bruk ULIKT bilde per variant. Hvis færre finnes, kan flere varianter dele bilde — ` +
    `da må undertittelen variere for å gi visuell forskjell.\n` +
    `- HARD REGEL: hvis du må sette mode="generer", er det ABSOLUTT FORBUDT å beskrive ` +
    `mennesker. Generer_beskrivelse må beskrive et MILJØ eller objekter (verktøy, kontor, ` +
    `produkt, materialer, arkitektur) som matcher stillingen — INGEN folk, INGEN ansikter, ` +
    `INGEN kroppsdeler, INGEN silhuetter. F.eks. for "Kokk": kjøkken-stasjon med kniver og ` +
    `råvarer (ingen kokk). For "CFO": stilrent møterom eller skrivebord (ingen leder).\n` +
    `\n` +
    `JSON-skjema per variant:\n` +
    `{\n` +
    `  "hovedtittel": "${job.tittel}",\n` +
    `  "undertittel": "<kort linje eller tom streng>",\n` +
    `  "bilde": { "mode": "bruk_bilde|generer", "bilde_indeks": 0, "generer_beskrivelse": "<hvis generer>" }\n` +
    `}\n` +
    `\n` +
    `Svar med JSON-array av nøyaktig ${AD_COUNT} elementer.`;

  const msg = await anthropic.messages.create({
    model: COPY_MODEL,
    max_tokens: 800,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const raw = msg.content[0].text.trim().replace(/^```json\s*|\s*```$/g, '');
  const variants = JSON.parse(raw);

  if (!Array.isArray(variants) || variants.length !== AD_COUNT) {
    throw new Error(`planThreeAds: forventet array med ${AD_COUNT} varianter, fikk ${Array.isArray(variants) ? variants.length : typeof variants}`);
  }
  // Valider bilde-indeks og normaliser feltnavn
  const maxIndex = Math.max(0, assets.brukbareEkteBilder.length - 1);
  const fellesUndertittel = deriveUndertittel(job); // SPEC v3 §e — alle 3 deler samme
  for (const v of variants) {
    v.hovedtittel = v.hovedtittel || job.tittel;
    v.undertittel = fellesUndertittel; // overstyrer Claude
    if (!v.bilde || typeof v.bilde !== 'object') {
      v.bilde = { mode: 'generer', bilde_indeks: null, generer_beskrivelse: 'realistisk arbeidsplass-scene' };
    }
    if (v.bilde.mode === 'bruk_bilde') {
      const idx = v.bilde.bilde_indeks ?? 0;
      if (assets.brukbareEkteBilder.length === 0 || idx > maxIndex || idx < 0) {
        v.bilde = { mode: 'generer', bilde_indeks: null, generer_beskrivelse: v.bilde.generer_beskrivelse || 'realistisk arbeidsplass-scene' };
      }
    }
  }
  return variants;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4 — bygg prompt for to-panel-template (§ E)
// Fast layout matchende Maarud / Nasjonalarkivet / CAPUS:
//   • Topp 50%: fargepanel med logo (composited) + "Vi søker"-pill + tittel
//   • Bunn 50%: fullbredde ekte foto
// Ingen CTA, ingen punktliste, ingen URL.
// ─────────────────────────────────────────────────────────────────────────────
function buildPrompt(variant, { cust, job, checklist, willCompositeLogo }) {
  const fontName = cust.font || 'Poppins';
  const titleColor    = cust.sekunder;
  const panelColor    = cust.primer;
  const accentColor   = cust.aksent;
  const usePalette    = checklist.harFarger;

  const hovedtittel   = variant.hovedtittel || job.tittel;
  const undertittel   = (variant.undertittel || '').trim();

  // Logo: ligger i topp-panelet, sentrert. Hvis vi compositerer i etterkant,
  // ber vi modellen om å la et større område stå tomt så pillen ikke kolliderer.
  const logoBlock = willCompositeLogo
    ? `LEAVE the top region of the canvas (y=200 to y=500) ABSOLUTELY CLEAN — no text, no logo, no pill, no graphic of any kind in this band. ONLY the panel background color. The real customer logo will be composited there in post-processing, ${LOGO_PLACEMENT.beskrivelse}, approximately ${LOGO_PLACEMENT.bredeProsent}% of canvas width. Do NOT place "Vi søker" or any other element in this clean band.`
    : `At the top of the panel (centered horizontally, around y=300), render the wordmark "${cust.merke}" in ${titleColor} uppercase ${fontName} letters, approximately ${LOGO_PLACEMENT.bredeProsent}% of the canvas width.`;

  // Visuell blokk for bunn-panelet
  // HARD REGEL: vi genererer ALDRI folk med AI. Hvis ingen ekte bilde finnes,
  // må scenen vise miljø/verktøy/utstyr/produkt/arkitektur — INGEN mennesker.
  const realismBlock = variant.bilde?.mode === 'generer'
    ? ` STRICTLY NO PEOPLE — ABSOLUTELY FORBIDDEN to depict any human figure, face, hand, arm, leg, body part, silhouette, or person in any way. Show ONLY environment, tools, equipment, products, architecture, materials, or atmospheric details relevant to the role. The scene must look like a real candid documentary photograph of an empty workspace or relevant objects: shot on a real camera with a 35–50mm lens, natural directional daylight, real surface textures, slight film grain, no HDR glow, no CGI sheen. If a person would naturally appear in this kind of scene, frame the photo to exclude them (over-the-shoulder, low angle, detail shot, etc.). NO people anywhere in the image.`
    : '';

  const visualBlock = variant.bilde?.mode === 'bruk_bilde'
    ? `USE the provided photograph for the bottom half, kept REAL and UNALTERED. Crop/scale it to fill the entire bottom half edge-to-edge while keeping the main subject(s) centered. Do not re-render the people or scene. No borders, no rounded corners, no filters.`
    : `Generate a real candid PHOTOGRAPH (not illustration, not 3D render) for the bottom half showing ${variant.bilde?.generer_beskrivelse || `a workplace environment or relevant tools/equipment for the role "${hovedtittel}", WITHOUT any people`}.${realismBlock}`;

  const undertittelBlock = undertittel
    ? `\n  4. A small subtitle directly below the title around y=920 in ${titleColor} (lighter weight, single line): "${undertittel}".`
    : '';

  // Tekst som MÅ gjengis bokstavelig
  const exactTextParts = [
    ...(willCompositeLogo ? [] : [cust.merke]),
    'Vi søker',
    hovedtittel,
    ...(undertittel ? [undertittel] : []),
  ];

  return `A finished vertical recruitment job advertisement (Norwegian stillingsannonse),
9:16 format, 1088x1920, fully designed and publish-ready for ${cust.merke}.
Minimal, premium executive recruitment poster style — clean, restrained, on-brand.

STRICT TWO-PANEL LAYOUT (50/50 split — single crisp horizontal seam at y=960):

TOP PANEL (y=0 to y=960): SOLID ${panelColor} background, no gradient, no texture, no photo. Contains, in this strict vertical order:
  1. ${logoBlock}
  2. Below the logo clean band, around y=560, a small rounded pill/badge centered horizontally containing the small text "Vi søker" in ${titleColor}. The pill has a thin ${titleColor} outline OR a subtle ${usePalette ? `${accentColor} or ${titleColor}` : 'tasteful'} fill. Sentence case "Vi søker" — do NOT put "Vi søker" near or behind the logo.
  3. Below the pill, around y=680 to y=900, the JOB TITLE in very large bold ${fontName} letters, ${titleColor}, centered horizontally, 1–2 lines max: "${hovedtittel}".${undertittelBlock}

BOTTOM PANEL (y=960 to y=1920): FULL-BLEED real photograph, edge to edge, no borders, no rounded corners. ${visualBlock}

NO CTA BUTTON, NO BULLET POINTS, NO URL, NO QR CODE, NO EXTRA GRAPHICS.

COLORS: ${usePalette ? `panel background ${panelColor}, all text and pill outline ${titleColor}, optional accent ${accentColor}` : 'neutral premium palette — dark warm panel, off-white text'}.
TYPOGRAPHY: ${fontName} family for the title; refined, confident, executive recruitment aesthetic.
TONE: ${cust.stemme || 'professional, warm, restrained — no clichés'}.

CRITICAL — render this text EXACTLY and spelled correctly, including å and ø:
${exactTextParts.join(', ')}. No other text, no lorem ipsum, no extra words, no watermark, no captions, no misspellings.

Repeat: minimal two-panel poster, strict 50/50 horizontal split at y=960, ${panelColor} top panel with the title and pill, full-bleed real photo on the bottom, NO buttons or bullets, all Norwegian text correctly spelled with å and ø.`;
}

// Logo-compositing: legg ekte logo-PNG oppå det ferdige bildet. Posisjon og
// størrelse varierer per konsepttype (LOGO_PLACEMENT). Safe zone er y=285..1635
// (av 1920) — logoen skal alltid ligge innenfor.
async function compositeLogoOnAd(adBuffer, logoBuffer, placement = LOGO_PLACEMENT) {
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
// Step 5 — generer 3 annonser (én per variant), n=1, composite logo
// ─────────────────────────────────────────────────────────────────────────────
async function generateOneAd({ variant, variantIndex, job, cust, checklist, assets }) {
  const willCompositeLogo = !!(checklist.harLogo && assets.logoFil?.buffer);
  const prompt = buildPrompt(variant, { cust, job, checklist, willCompositeLogo });

  const common = { model: IMAGE_MODEL, prompt, size: IMAGE_SIZE, quality: IMAGE_QUALITY, n: 1 };
  let buffer;
  let visualSource;
  if (variant.bilde?.mode === 'bruk_bilde' && assets.brukbareEkteBilder[variant.bilde.bilde_indeks]) {
    const photo = assets.brukbareEkteBilder[variant.bilde.bilde_indeks];
    const ext = (photo.mediaType || 'image/png').split('/')[1] || 'png';
    const resp = await openai.images.edit({
      ...common,
      image: await toFile(photo.buffer, `reference.${ext}`, { type: photo.mediaType || 'image/png' }),
    });
    buffer = Buffer.from(resp.data[0].b64_json, 'base64');
    visualSource = `bilde[${variant.bilde.bilde_indeks}] (${photo.source})`;
  } else {
    const resp = await openai.images.generate(common);
    buffer = Buffer.from(resp.data[0].b64_json, 'base64');
    visualSource = 'AI-generert';
  }

  let logoComposited = false;
  if (willCompositeLogo) {
    buffer = await compositeLogoOnAd(buffer, assets.logoFil.buffer, LOGO_PLACEMENT);
    logoComposited = true;
  }

  return { variantIndex, variant, buffer, visualSource, logoComposited };
}

async function generateThreeAds({ variants, job, cust, checklist, assets }) {
  console.log(`   Starter ${variants.length} parallelle GPT Image 2-kall...`);
  const tasks = variants.map((variant, i) =>
    generateOneAd({ variant, variantIndex: i, job, cust, checklist, assets })
      .then((ad) => {
        const logoNote = ad.logoComposited ? ' + logo composited' : '';
        const sub = ad.variant.undertittel ? ` "${ad.variant.undertittel}"` : '';
        console.log(`     ✓ ${i + 1}/${variants.length}${sub} — ${ad.visualSource}${logoNote}`);
        return ad;
      })
  );
  const ads = await Promise.all(tasks);
  return ads.sort((a, b) => a.variantIndex - b.variantIndex);
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
  return String(i + 1).padStart(2, '0'); // 01, 02, 03
}
function adFileName({ base, index }) {
  return `${base}-${suffixFor(index)}.png`;
}

async function saveAds(ads, { cust, job }) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const base = imageBaseName({ cust, job });
  const files = [];
  for (let i = 0; i < ads.length; i++) {
    const filename = adFileName({ base, index: i });
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
    const filename = adFileName({ base, index: i });
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

  // Nettsted-skraping + research-søk i parallel
  if (job.nettsted) console.log(`→ Skraper nettsted: ${job.nettsted}...`);
  if (job.dittFirma) console.log(`→ Web-research på "${job.dittFirma}"...`);
  const [scraped, research] = await Promise.all([
    job.nettsted ? scrapeWebsiteAssets(job.nettsted) : Promise.resolve(null),
    job.dittFirma ? researchCompany({ navn: job.dittFirma, nettsted: job.nettsted, sted: job.sted }) : Promise.resolve(null),
  ]);
  if (scraped?.feil) {
    console.log(`   ⚠ skraping feilet: ${scraped.feil}`);
  } else if (scraped) {
    console.log(`   ${scraped.colors.length} farge(r), ${scraped.images.length} content-bilde(r), ${scraped.logoCandidates?.length ?? 0} logo-kandidat(er)${scraped.font ? `, font: ${scraped.font}` : ''}`);
    if (scraped.debug) {
      const d = scraped.debug;
      console.log(`   [debug] kandidater: logo=${d.logoKandidater}/${d.logoLastetNed}lastet, content=${d.contentKandidater}, prøvd=${d.prøvd}, forSmaa=${d.forSmaa}, feilet=${d.feilet}`);
    }
  }
  if (research?.feil) {
    console.log(`   ⚠ research feilet: ${research.feil}`);
  } else if (research?.ignored) {
    console.log(`   ⚠ research ignorert (sikkerhet=lav)`);
  } else if (research) {
    console.log(`   ${research.bransje}: ${research.hva_de_gjør} | tone: ${research.tone}`);
  }
  const researchContext = research && !research.feil && !research.ignored ? research : null;

  resolveBranding({ cust, job, scraped });
  console.log(`   Fargekilde: ${cust.fargerKilde} (${cust.alle.length} hex)`);
  console.log(`   Panel ${cust.primer} / Tekst ${cust.sekunder} / Aksent ${cust.aksent} — kontrast ${cust.kontrast.kontrast.toFixed(2)}${cust.kontrast.justert ? ` (justert: ${cust.kontrast.justert})` : ''}`);
  if (cust.font) console.log(`   Font: ${cust.font} (${cust.fontKilde})`);
  const scrapedLogoCandidates = scraped?.logoCandidates ?? [];
  console.log(`   Bilder: jobb=${job.jobbPhotoUrls.length}, bibliotek=${cust.bildebibliotekUrls.length}, nettsted=${scraped?.images.length ?? 0}, kunde-logo=${cust.logoUrls.length}, nettsted-logo-kandidater=${scrapedLogoCandidates.length}`);

  console.log(`→ Analyserer + vision-verifiserer logo-kandidater...`);
  const assets = await analyzeAssets({
    job, cust,
    scrapedImages: scraped?.images ?? [],
    scrapedLogoCandidates,
    merke: cust.merke,
  });

  // HARD HALT: ingen verifisert logo, ingen kjøring
  if (!assets.logoFil) {
    const avvist = assets.alle.filter((r) => r.source === 'nettsted-logo' && r.analyse && !r.analyse.match);
    let detalj = '';
    if (avvist.length) {
      detalj = '\nAvviste logo-kandidater fra nettstedet:\n' +
        avvist.map((r) => `  • ${r.url.slice(0, 80)} — tekst: "${r.analyse?.tekst || '(ingen)'}", grunn: ${r.analyse?.notat || 'ikke vurdert som riktig logo'}`).join('\n');
    }
    throw new Error(
      `Logo mangler for "${cust.merke}". Vi går ikke videre uten verifisert logo.\n` +
      `Fix: 1) Last opp logo i Kunder-databasen (Logo-feltet), ELLER ` +
      `2) Last opp logo på jobben (Bilder til annonse — vision ruter den), ELLER ` +
      `3) Bekreft at nettstedet "${job.nettsted || '(ikke satt)'}" eksponerer en gjenkjennelig logo med selskapsnavnet.${detalj}`
    );
  }
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

  console.log(`→ Planlegger ${AD_COUNT} annonse-varianter med Claude...`);
  const variants = await planThreeAds({ job, cust, assets, checklist, researchContext });
  variants.forEach((v, i) => {
    const visual = v.bilde?.mode === 'bruk_bilde' ? `bilde[${v.bilde.bilde_indeks}]` : 'generer';
    const sub = v.undertittel ? ` "${v.undertittel}"` : '';
    console.log(`     ${i + 1}. ${visual}${sub}`);
  });

  console.log(`→ Genererer ${variants.length} annonser med GPT Image 2 (parallelt)...`);
  const ads = await generateThreeAds({ variants, job, cust, checklist, assets });

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
