# Xcruiter ad helper (v0.1)

Generates a finished Norwegian recruitment ad from Notion data:
**Notion** (job marked *Klar for annonse*) → **Claude** writes the copy →
**GPT Image 2** (OpenAI) renders the ad → image saved → job set to *Annonse laget*.

## Setup (once)
1. `npm install`
2. `cp .env.example .env` and fill in your three keys.
3. In Notion, share the **Kunder** and **Stillinger** databases with your integration.

## Run
```
npm start
```
It picks the first job marked *Klar for annonse*, generates 2 variants into `./output/`,
and flips the job to *Annonse laget*.

## The hero photo (§4)
- If the customer's **Bildebibliotek** (a Files property on the Kunder sheet) has an image,
  it is used as the hero and kept unaltered (GPT Image 2 "edit").
- If not, the worker is generated from scratch (the §5 realism fallback).
- To test with a local photo right now, set `LOCAL_PHOTO_PATH` in `.env` to an image on disk.

## Known v0.1 limits (next steps)
- Images are saved locally, not yet pushed back into Notion (Notion file-upload is a separate step).
- One job per run. A loop / Notion-webhook trigger comes in v0.2.
- The model name (`gpt-image-2`) and copy model are constants at the top of the script.
