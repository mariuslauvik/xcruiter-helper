# Xcruiter pipeline — spec & handoff (for Claude Code)

This document describes the Xcruiter ad pipeline and what still needs to be
finished/verified. Hand this to Claude Code together with `xcruiter-helper.mjs`.

## Goal (the flow we want)

1. The customer fills in a **form** in Notion (the role, the angle, and uploads a photo).
2. When done, the customer flips the job's **Status → "Levert"**.
3. "Levert" **triggers the pipeline**.
4. The pipeline generates the finished ad(s) and **attaches them back into Notion**,
   on the same job, in the **"Annonser"** field — and sets Status → **"Annonse laget"**.

The customer never leaves Notion. Everything else is automatic.

## Notion structure (already set up — do NOT recreate)

Project: **Xcruiter**. Two databases:

- **Kunder** (data source `713cc956-67c6-4731-8441-3f5cbdc47e5c`) — one row per customer.
  Branding lives here: `Bedriftsnavn` (title), `Merkekode`, `Merkevarefarger`
  (one text field: "Primær #... / sekundær #... / aksent #..."), `Font`,
  `Merkevarestemme`, `Nettside`, `Bildebibliotek` (files), `Logo` (files), `Status`.
- **Stillinger** (data source `c0a69668-b0c1-405c-a6df-b9464395abd6`) — one row per job/ad.
  Fields: `Stillingstittel` (title), `Ansettelsestype` (select), `Lokasjon`,
  `Annonsevinkel`, `Beskrivelse`, `Antall`, `Kunde` (relation → Kunder),
  `Annonsebilder` (files — the customer's uploaded photo for THIS job),
  `Annonser` (files — **where finished ads land**), `Status` (select).

**Status flow on Stillinger:** `Ny` → `Levert` (customer-triggered) → `Annonse laget`
(pipeline done, ads attached) → `Publisert`.

Already created in Notion during the build:
- `Levert` status option (the trigger).
- `Annonser` files field (the output).
- A form view **"Stillingsskjema (kunde)"** on Stillinger. It still needs to be
  **published/shared** as a public form link from the Notion UI so customers can submit
  without a Notion account.

## The worker: `xcruiter-helper.mjs` (Node, ESM)

One run does this end to end:

1. Query Stillinger for the first row with `Status = "Levert"`.
2. Read the job fields + follow `Kunde` → read the customer's branding.
3. Ask Claude (Anthropic) for the copy: a hook (≤72 chars) + three short bullets,
   humanized, correct å/ø — returned as JSON.
4. Build the §8 image prompt from the master rules (branding, layout, safe zone, exact text).
5. Hero image:
   - photo from the job's `Annonsebilder` (preferred), else the customer's `Bildebibliotek`,
     else generate the person from scratch (the §5 realism fallback);
   - with a photo → OpenAI `images.edit` (keeps the real person, builds around it);
     without → `images.generate`. Model `gpt-image-2`, size `1088x1920` (9:16), quality `high`, n=2.
6. Save the images locally to `./output/` (backup).
7. **Upload the images into Notion** and attach them to the job's `Annonser` field
   (`fileUploads.create` → `fileUploads.send` → `pages.update`), then set Status → `Annonse laget`.

Config constants live at the top of the file (model names, size, count, status names, data-source IDs).

## What is VERIFIED vs. what to TEST

Verified locally (syntax + SDK signatures): all imports resolve; Notion v5
`dataSources.query`, `pages.retrieve/update`, `fileUploads.create/send`; OpenAI v6
`images.edit/generate`; Anthropic `messages.create`.

NOT yet run against the live APIs (the author had no network to Notion/OpenAI). Treat the
first run as the test. Most likely things to confirm/fix on first run:

- **Notion file upload-back** (step 7) — the create→send→attach flow is written to the v5
  SDK shape but unproven. If attaching to `Annonser` fails, check the files-property write
  format (`{ type: 'file_upload', file_upload: { id }, name }`) against the current Notion docs.
- **`gpt-image-2` access** — OpenAI may require Organization Verification before the model
  unlocks. The size must stay divisible by 16 (that's why it's 1088×1920, not 1080×1920).
- **Copy model string** (`claude-sonnet-4-6`) — change the constant if the account uses another.
- **Soul vs GPT Image text rendering** is not relevant here; we use GPT Image 2 directly via OpenAI.

## Phase 2 — make it fully automatic (no polling)

Right now the worker is run on demand and picks one "Levert" job. To make it hands-off:

1. Deploy the worker as an endpoint (Vercel function fits the existing pipeline).
2. In Notion, add a **database automation** on Stillinger: *when Status changes to "Levert",
   Send webhook* to that endpoint, with the page ID in the payload.
3. The endpoint runs the same steps for that one job. (Notion can't download/generate/upload
   itself — it only fires the webhook; all real work stays in the worker.)

## Keys (in `.env`, gitignored)

```
NOTION_TOKEN=ntn_...        # Notion internal integration; share Kunder + Stillinger with it
OPENAI_API_KEY=sk-...       # GPT Image 2
ANTHROPIC_API_KEY=sk-ant-...# the copy step
LOCAL_PHOTO_PATH=           # optional: local image to use as hero (testing)
```

## How to test the loop now

1. `npm install`, fill `.env`.
2. In Notion, take a job (e.g. the "Rørlegger – fast stilling" under Bergen Rør), optionally
   upload a photo to its `Annonsebilder`, and set its Status to `Levert`.
3. `npm start`. Watch it generate, attach to `Annonser`, and flip to `Annonse laget`.
4. To test the photo path with a local file instead, set `LOCAL_PHOTO_PATH` in `.env`.
