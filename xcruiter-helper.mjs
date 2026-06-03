// Xcruiter ad helper — v0.2
// Flow: find a "Levert" job in Notion → read job + customer branding →
// ask Claude for the ad copy → build the §8 prompt → generate with GPT Image 2
// (OpenAI) → save images → upload to the job's "Annonser" field in Notion →
// set the job to "Annonse laget".
//
// Hero photo precedence:
//   LOCAL_PHOTO_PATH (test)
//   → job's Annonsebilder (customer's job-specific upload)
//   → customer's Bildebibliotek (brand-wide photos)
//   → customer's Logo (last fallback)
//   → generated from scratch.
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

const NOTION_INPUT_PHOTO_COL  = 'Annonsebilder'; // kundens jobb-spesifikke bilde (på Stillinger)
const NOTION_OUTPUT_FILE_COL  = 'Annonser';      // ferdige annonser legges her (på Stillinger)

const IMAGE_MODEL   = 'gpt-image-2';   // OpenAI GPT Image 2
const IMAGE_SIZE    = '1088x1920';     // 9:16; width+height must be divisible by 16 (1080 is not)
const IMAGE_QUALITY = 'high';          // low | medium | high
const IMAGE_COUNT   = 2;               // hedge against å/ø spelling errors

const COPY_MODEL = 'claude-sonnet-4-6'; // change if your account uses a different model string

const OUTPUT_DIR = path.resolve('./output');

// Test convenience: if you set LOCAL_PHOTO_PATH in .env to an image on disk
// (e.g. the Stian photo), the script uses THAT as the hero image instead of
// looking in Notion. Leave it empty for normal operation.
const LOCAL_PHOTO_PATH = process.env.LOCAL_PHOTO_PATH || '';

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
  return '';
};
const firstRelationId = (p) => p?.relation?.[0]?.id ?? null;
const firstFileUrl = (p) => {
  const f = p?.files?.[0];
  if (!f) return null;
  return f.type === 'external' ? f.external.url : f.file?.url ?? null;
};

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
  const hex = (s.match(/#[0-9A-Fa-f]{6}/g) || []);
  return {
    primer:   hex[0] || '#1B3A2F',
    sekunder: hex[1] || '#E8DCC4',
    aksent:   hex[2] || '#C2410C',
  };
}

async function readJobAndCustomer(jobPage) {
  const jp = jobPage.properties;
  const job = {
    pageId: jobPage.id,
    tittel:     txt(jp['Stillingstittel']),
    type:       txt(jp['Ansettelsestype']),
    sted:       txt(jp['Lokasjon']),
    vinkel:     txt(jp['Annonsevinkel']),
    beskrivelse:txt(jp['Beskrivelse']),
    soknadslenke: txt(jp['Søknadslenke']),
    kundeId:    firstRelationId(jp['Kunde']),
    jobbPhotoUrl: firstFileUrl(jp[NOTION_INPUT_PHOTO_COL]), // kundens job-specific upload
  };
  if (!job.kundeId) throw new Error(`Job "${job.tittel}" has no linked Kunde.`);

  const custPage = await notion.pages.retrieve({ page_id: job.kundeId });
  const cp = custPage.properties;
  const colors = parseColors(txt(cp['Merkevarefarger']));
  const cust = {
    merke:   txt(cp['Bedriftsnavn']),
    kode:    txt(cp['Merkekode']),
    font:    txt(cp['Font']),
    stemme:  txt(cp['Merkevarestemme']),
    url:     txt(cp['Nettside']),
    ...colors,
    bildebibliotekUrl: firstFileUrl(cp['Bildebibliotek']),
    logoUrl:           firstFileUrl(cp['Logo']),
  };
  return { job, cust };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — ask Claude for the ad copy (humanized, correct å/ø)
// ─────────────────────────────────────────────────────────────────────────────
async function writeCopy({ vinkel, beskrivelse, stemme, merke }) {
  const system =
    'Du skriver kort, menneskelig norsk reklametekst for stillingsannonser. ' +
    'Følg merkevarestemmen. Ingen AI-klisjeer, ingen "stilling"-byråkrati — folk søker en bedre hverdag. ' +
    'Svar KUN med rå JSON, ingen markdown, ingen forklaring.';
  const user =
    `Merke: ${merke}\nStemme: ${stemme}\nVinkel: ${vinkel}\nBeskrivelse: ${beskrivelse}\n\n` +
    'Lag annonsetekst. Returner JSON med nøyaktig disse feltene:\n' +
    '{"hook_l1": "linje 1 av overskrift", "hook_l2": "linje 2 av overskrift", ' +
    '"hook_nokkelord": "ordet/ordene fra hooken som skal ha aksentfarge", ' +
    '"punkt1": "...", "punkt2": "...", "punkt3": "..."}\n' +
    'Regler: hele hooken (l1+l2) ≤ 72 tegn. Hvert punkt 2–4 ord. Korrekt å og ø.';

  const msg = await anthropic.messages.create({
    model: COPY_MODEL,
    max_tokens: 400,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const raw = msg.content[0].text.trim().replace(/^```json\s*|\s*```$/g, '');
  const c = JSON.parse(raw);
  c.hook_hele = `${c.hook_l1} ${c.hook_l2}`.trim();
  return c;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4 — build the §8 master prompt
// ─────────────────────────────────────────────────────────────────────────────
function buildPrompt({ cust, job, copy, hasPhoto }) {
  const heroBlock = hasPhoto
    ? 'use the PROVIDED photograph as the hero image, kept real and unaltered; ' +
      'build the design around it, do not re-render or change the person.'
    : 'one real, candid photograph of the worker mid-task, natural skin texture with visible pores and ' +
      'subtle imperfections, asymmetrical natural features, relaxed unposed expression, anatomically correct ' +
      'hands with five fingers, natural eyes and teeth, real worn clothing with creases, documentary ' +
      'photojournalistic realism, shot on a real camera in natural light — not airbrushed, not glossy, ' +
      'not symmetrical, no plastic skin, no AI-perfect features, no extra fingers.';

  return `A complete, finished vertical recruitment job advertisement (Norwegian stillingsannonse),
9:16 format, 1080x1920, fully designed and publish-ready with text, layout and branding baked in.
Premium editorial poster, warm and on-brand for ${cust.merke}.

LAYOUT top to bottom (ALL content inside the safe zone y=285 to y=1635):
- Top of safe zone: the wordmark ${cust.merke} in ${cust.sekunder} uppercase ${cust.font}-style letters,
  with a small ${cust.aksent} label reading VI SØKER to the right.
- Headline in ${cust.font}-style font on two lines: ${copy.hook_l1} / ${copy.hook_l2}
  with ${copy.hook_nokkelord} in ${cust.aksent}.
- Center image block, inside a softly rounded frame: ${heroBlock}
- Role line in clean sans-serif: ${job.type} · ${job.sted}.
- Three short bullet points, each with a small ${cust.aksent} dot, in ${cust.sekunder}:
  ${copy.punkt1} / ${copy.punkt2} / ${copy.punkt3}.
- CTA, still inside the safe zone (NOT near the bottom edge): a solid ${cust.aksent} rounded button with
  ${cust.sekunder} uppercase text SØK NÅ, and small ${cust.sekunder} text ${cust.url}.

SAFE ZONE (critical): keep ALL text, the CTA button, the wordmark and the focal subject within the centered
safe area between y=285 and y=1635. The top strip (y=0 to 285) and the bottom strip (y=1635 to 1920) must
contain ONLY background and atmosphere — never text, button or logo. Be especially strict at the bottom:
the SØK NÅ button sits well inside the safe zone, never near the bottom edge, because Meta's UI covers the
lowest ~20%.

COLORS: background ${cust.primer}, text ${cust.sekunder}, accents and button ${cust.aksent}.
TONE: ${cust.stemme}.

CRITICAL — render this text exactly and spelled correctly, including å and ø:
${cust.merke}, VI SØKER, ${copy.hook_hele}, ${job.type} · ${job.sted}, ${copy.punkt1}, ${copy.punkt2},
${copy.punkt3}, SØK NÅ, ${cust.url}. No other text, no lorem ipsum, no extra words, no watermark, no misspellings.

Repeat: vertical 9:16 finished job ad; ALL text, CTA and logo strictly inside the safe zone y=285–1635 with
empty background top and bottom; ${cust.primer} background; ${cust.sekunder} and ${cust.aksent} brand colors;
all Norwegian text spelled exactly with correct å and ø; publish-ready.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5 — generate with GPT Image 2 (edit if we have a hero photo, else generate)
// ─────────────────────────────────────────────────────────────────────────────
async function loadPhotoBuffer({ job, cust }) {
  if (LOCAL_PHOTO_PATH) {
    return { buffer: await fs.readFile(LOCAL_PHOTO_PATH), source: 'lokal testfil' };
  }
  const candidates = [
    { url: job.jobbPhotoUrl,         source: `jobbens "${NOTION_INPUT_PHOTO_COL}"` },
    { url: cust.bildebibliotekUrl,   source: 'kundens Bildebibliotek' },
    { url: cust.logoUrl,             source: 'kundens Logo (fallback)' },
  ];
  for (const c of candidates) {
    if (!c.url) continue;
    const res = await fetch(c.url); // Notion-fil-URL-er er midlertidige — last ned nå
    if (!res.ok) throw new Error(`Kunne ikke laste ned ${c.source} (${res.status})`);
    return { buffer: Buffer.from(await res.arrayBuffer()), source: c.source };
  }
  return null;
}

async function generateImages(prompt, photoBuffer) {
  const common = { model: IMAGE_MODEL, prompt, size: IMAGE_SIZE, quality: IMAGE_QUALITY, n: IMAGE_COUNT };
  const resp = photoBuffer
    ? await openai.images.edit({ ...common, image: await toFile(photoBuffer, 'reference.png', { type: 'image/png' }) })
    : await openai.images.generate(common);
  return resp.data.map((d) => Buffer.from(d.b64_json, 'base64'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 6 — save with the §11 naming convention
// ─────────────────────────────────────────────────────────────────────────────
function camel(s) {
  return s.replace(/[^a-zA-ZæøåÆØÅ ]/g, '').split(/\s+/).slice(0, 3)
    .map((w, i) => i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
}
function imageBaseName({ cust, job }) {
  const kode  = (cust.kode || 'XX').toUpperCase();
  const rolle = (job.tittel.split(/[\s–-]/)[0] || 'ROLLE').toUpperCase();
  const vinkel = camel(job.vinkel) || 'Vinkel';
  return `${kode}-${rolle}-${vinkel}-Foto`;
}
function suffixFor(i) {
  return i === 0 ? '01' : `01${String.fromCharCode(97 + i)}`; // 01, 01b, 01c...
}
async function saveImages(buffers, { cust, job }) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const base = imageBaseName({ cust, job });
  const files = [];
  for (let i = 0; i < buffers.length; i++) {
    const file = path.join(OUTPUT_DIR, `${base}-${suffixFor(i)}.png`);
    await fs.writeFile(file, buffers[i]);
    files.push(file);
  }
  return files;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 6b — last opp bildene tilbake i Notion (Stillinger → "Annonser")
// ─────────────────────────────────────────────────────────────────────────────
async function uploadImagesToNotion(buffers, { cust, job }) {
  const base = imageBaseName({ cust, job });
  const uploaded = [];
  for (let i = 0; i < buffers.length; i++) {
    const filename = `${base}-${suffixFor(i)}.png`;
    const upload = await notion.fileUploads.create({
      filename,
      content_type: 'image/png',
    });
    await notion.fileUploads.send({
      file_upload_id: upload.id,
      file: {
        filename,
        data: new Blob([buffers[i]], { type: 'image/png' }),
      },
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
    },
  });
  return uploaded.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 7 — close the loop
// ─────────────────────────────────────────────────────────────────────────────
async function markDone(pageId) {
  await notion.pages.update({
    page_id: pageId,
    properties: { Status: { select: { name: STATUS_DONE } } },
  });
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

  console.log('→ Writing copy with Claude...');
  const copy = await writeCopy(job);
  console.log(`   hook: ${copy.hook_hele}`);

  const photo = await loadPhotoBuffer({ job, cust });
  const hasPhoto = !!photo;
  console.log(`→ Hero image: ${hasPhoto ? `using ${photo.source}` : 'generating (no photo found)'}`);

  const prompt = buildPrompt({ cust, job, copy, hasPhoto });
  console.log('→ Generating with GPT Image 2 (this takes a bit)...');
  const buffers = await generateImages(prompt, photo?.buffer ?? null);

  const files = await saveImages(buffers, { cust, job });
  console.log(`→ Saved ${files.length} image(s) locally:`);
  files.forEach((f) => console.log(`   ${f}`));

  console.log(`→ Laster opp til Notion-egenskap "${NOTION_OUTPUT_FILE_COL}"...`);
  const uploaded = await uploadImagesToNotion(buffers, { cust, job });
  console.log(`   ${uploaded} bilde(r) festet til jobben i Notion.`);

  await markDone(job.pageId);
  console.log(`→ Set "${job.tittel}" to "${STATUS_DONE}". Done.`);
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
