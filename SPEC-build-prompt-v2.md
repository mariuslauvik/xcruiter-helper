# Xcruiter – oppgradering av annonse-generatoren (build prompt v2)

Til Claude Code. Dette er en spec for å bygge om hvordan `xcruiter-helper.mjs` lager
annonsene. **Følg anti-vibe-coding-skillen:** les hele `xcruiter-helper.mjs` først,
forstå dagens flyt, og gjør endringene **én seksjon om gangen** med diff + godkjenning
før du går videre. Ikke dump hele filen på nytt i én sleng.

## Hvorfor

Dagens kode har to feil:

1. **Samme annonse hver gang.** `buildPrompt()` bygger én fast layout, og
   `generateImages()` kjører `n=2` av *samme* prompt. Vi får to nesten like bilder.
2. **AI-tegn + bruker ikke ekte bilder.** `loadPhotoBuffer()` tar bare første fil,
   uten å analysere hva det er eller om det er brukbart. Finnes ikke bilde, genererer
   den en person fra bunn → tydelige AI-tells.

Mål: **5 distinkte annonser per kjøring**, all input faktisk analysert, ekte bilder
foretrukket framfor generering, og foto-realisme når vi *må* generere.

---

## Seksjon 1 — Les og analyser ALL input

Utvid `readJobAndCustomer()`:

- **Stilling:** tittel, ansettelsestype, lokasjon, annonsevinkel, beskrivelse,
  søknadslenke, søknadsfrist, og **alle** filene i `Annonsebilder` (ikke bare første).
- **Kunde:** bedriftsnavn, merkekode, font, merkevarestemme, nettside,
  merkevarefarger (parse **alle** hex), **alle** filene i `Bildebibliotek`, og `Logo`
  som et **eget** felt (ikke slå sammen med Bildebibliotek slik koden gjør nå).

Returner bilder som lister, og hold logo adskilt.

---

## Seksjon 2 — NY: bildeanalyse (vision)

Lag `analyzeAssets()`. For hvert opplastede bilde (jobb + kundens bibliotek):

1. Hent bytene (Notion-URL-er er midlertidige — hent dem nå), gjør om til base64.
2. Send til Claude med vision (samme Anthropic-SDK, `claude-sonnet-4-6` har vision).
3. Be om rå JSON per bilde:
   `{ "hva": "...", "type": "person|arbeidsplass|produkt|logo|annet",
   "brukbar_som_annonsebilde": true|false, "kvalitet": "høy|middels|lav", "notat": "..." }`

Bygg en oversikt: hvilke ekte bilder er brukbare som annonsebilde, og hvilket bilde er
logoen. **Regel: et ekte, brukbart bilde slår alltid AI-generering.** Det er det
viktigste grepet for å unngå AI-tells og for å representere brandet riktig.

---

## Seksjon 3 — Ja/Nei-sjekkliste (styrer prompten)

Lag `buildChecklist()` som samler dette fra data + bildeanalysen. Disse svarene
bestemmer hvordan hver prompt bygges:

- **Brukbart jobbbilde?** Ja → bruk det (`images.edit`, bygg rundt det). Nei → vurder
  kundens bibliotek, ellers generer med realisme-teknikken.
- **Logo lastet opp?** Ja → logo skal med i **alle** annonser. Nei → render merkenavnet
  som ordmerke i merkefont.
- **Merkevarefarger?** Ja → bruk primær/sekundær/aksent i **alle**. Nei → nøytral
  premium-palett.
- **Ansettelsestype satt?** → må synlig frem i **minst 2** annonser.
- **Lokasjon satt?** → må frem i **minst 1** annonse.
- **Vinkel + beskrivelse** → primær kilde til budskapet. Beskrivelsen er viktigst:
  forstå hva stillingen faktisk er før noe genereres.

---

## Seksjon 4 — 5 distinkte annonser

Erstatt `writeCopy()` + `n=2` med `planFiveAds()`: ett Claude-kall som returnerer en
JSON-liste med **nøyaktig 5 konsepter**. Hvert konsept skal være **visuelt og
konseptuelt forskjellig** — dette er kritisk for diversitet i Meta Andromeda.

- **Annonse 1 = ren tekst.** Typografisk, minimal, ingen/lite foto. Logo hvis den
  finnes. Merkefarger. Ikke noe fancy.
- **Annonse 2–5 = fire ulike retninger.** Forslag (Claude kan designe egne så lenge de
  er distinkte og dekker reglene under):
  - Foto-dominant: stort ekte bilde av personen/arbeidsplassen, hook over.
  - Fordeler i fokus: punktene (fra beskrivelse + vinkel) som helten, typografisk.
  - Direkte spørsmål-hook: tiltaler kandidaten ("Lei av tilfeldig turnus?").
  - Premium redaksjonelt: stilrent, merkefarge-drevet, sofistikert.

JSON per konsept:
```
{
  "type": "renTekst|foto|fordeler|spørsmål|premium",
  "layout": "kort beskrivelse av oppsettet",
  "hook_l1": "...", "hook_l2": "...", "hook_nokkelord": "...",
  "punkter": ["...", "...", "..."],
  "visual": { "mode": "bruk_bilde|generer", "bilde_indeks": 0, "generer_beskrivelse": "..." },
  "bruk_logo": true|false,
  "bruk_ansettelsestype": true|false,
  "bruk_lokasjon": true|false,
  "fargebruk": "hvordan primær/sekundær/aksent brukes"
}
```

Regler som MÅ håndheves i prompten til Claude:
- Ansettelsestype frem i ≥2 konsepter, lokasjon i ≥1, merkefarger i alle, logo i alle
  (hvis logo finnes).
- Foretrekk ekte brukbare bilder (`mode: "bruk_bilde"`) der et passer; generer bare når
  ingen passende ekte bilde finnes.
- **Kjør all tekst gjennom humanizer-prinsippene** (ingen AI-klisjeer, ingen
  rule-of-three, ingen em-dash-spam, korrekt å og ø). Folk søker en bedre hverdag —
  ikke "spennende muligheter".

---

## Seksjon 5 — Bygg prompt per konsept + realisme

`buildPrompt(concept, ...)` bygges per konsept i stedet for én fast:

- Behold §8-reglene: safe zone y=285–1635, all tekst/CTA/logo innenfor, tom bakgrunn
  topp/bunn, eksakt korrekt norsk tekst, merkefarger.
- Layout varierer etter `concept.type`.
- **Realisme når bildet genereres** (mål: foto-realismen i belte-bildet, ikke
  AI-tells som i kokk-bildet): ekte kamera og objektiv, naturlig retningslys, ekte
  hudtekstur med porer/fine linjer/små ujevnheter (aldri plastaktig glatt), korrekte
  hender, naturlige øyne og tenner, lett filmkorn, candid og uposert. Legg inn
  forbudsspråk mot AI-tells (ingen vokslignende hud, ingen overdreven symmetri, ingen
  ekstra fingre, ingen HDR-glød).
- **Logo eksakt:** tekst-til-bilde gjengir sjelden en logo riktig. Mest pålitelig er å
  **komponere den ekte logo-PNG-en oppå** det ferdige bildet (f.eks. med `sharp`),
  plassert i safe zone. Alternativ: send logo som ekstra referansebilde til
  `images.edit`. Anbefaling: compositing for eksakthet.
- **Viktigst:** har konseptet et ekte brukbart bilde → `images.edit` rundt det = null
  AI-tells.

---

## Seksjon 6 — Generering og lagring

- Loop de 5 konseptene: `images.edit` hvis bilde tildelt, ellers `images.generate`,
  **`n=1` per konsept** (fjern `IMAGE_COUNT = 2`).
- Naming (§11) med type-token: `KODE-ROLLE-VINKEL-TYPE-NN`
  (TYPE = RenTekst/Foto/Fordeler/Spørsmål/Premium), så de 5 er lette å skille.
- `publishToNotion()`: fest alle 5 i `Annonser`, sett status til "Annonse laget".

---

## Rekkefølge (anti-vibe-coding)

1. Les hele `xcruiter-helper.mjs`. Oppsummer dagens flyt for meg først.
2. Implementer seksjon for seksjon (1 → 6), vis diff per seksjon, vent på OK.
3. Test mot eksempelet (Bergen Rør eller Fjordkroken): sett en stilling til "Levert" og
   kjør. Sjekk at du får 5 ulike annonser, at ekte bilde brukes når det finnes, og at
   logo/merkefarger er med.

## Notater

- `claude-sonnet-4-6` har vision — bruk samme klient til bildeanalysen.
- Notion-fil-URL-er er midlertidige: hent bytene i samme kjøring som analysen.
- Masterregel-fila (`xcruiter-master-ad-generation-rules`) bør bumpes til v1.3 så
  5-type-systemet + sjekklista står dokumentert der også. Si fra, så hjelper jeg med
  den teksten.
