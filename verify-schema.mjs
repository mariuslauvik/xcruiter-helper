// Engangs-verifisering: sjekk at Notion-skjemaet matcher spec-en.
import 'dotenv/config';
import { Client as Notion } from '@notionhq/client';

const STILLINGER_DS = 'c0a69668-b0c1-405c-a6df-b9464395abd6';
const KUNDER_DS     = '713cc956-67c6-4731-8441-3f5cbdc47e5c';

const notion = new Notion({ auth: process.env.NOTION_TOKEN });

function check(name, ok, detail) {
  console.log(`${ok ? '✓' : '✖'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

const stillinger = await notion.dataSources.retrieve({ data_source_id: STILLINGER_DS });
const kunder     = await notion.dataSources.retrieve({ data_source_id: KUNDER_DS });

console.log('--- Stillinger-skjema ---');
const sProps = Object.keys(stillinger.properties);
console.log('  Felter:', sProps.join(', '));
const statusProp = stillinger.properties.Status;
const statusOpts = statusProp?.select?.options.map((o) => o.name) ?? [];
console.log('  Status-alternativer:', statusOpts.join(', '));
check('Status-feltet er av type select', statusProp?.type === 'select');
check('Status-alternativ "Levert" finnes',     statusOpts.includes('Levert'));
check('Status-alternativ "Annonse laget" finnes', statusOpts.includes('Annonse laget'));
check('Felt "Annonsebilder" finnes (input)',  !!stillinger.properties.Annonsebilder, stillinger.properties.Annonsebilder?.type);
check('Felt "Annonser" finnes (output)',      !!stillinger.properties.Annonser,      stillinger.properties.Annonser?.type);

console.log('\n--- Kunder-skjema ---');
const kProps = Object.keys(kunder.properties);
console.log('  Felter:', kProps.join(', '));
check('Felt "Bildebibliotek" finnes', !!kunder.properties.Bildebibliotek, kunder.properties.Bildebibliotek?.type);
check('Felt "Logo" finnes',           !!kunder.properties.Logo,           kunder.properties.Logo?.type);

console.log('\n--- Jobber i "Levert" akkurat nå ---');
const q = await notion.dataSources.query({
  data_source_id: STILLINGER_DS,
  filter: { property: 'Status', select: { equals: 'Levert' } },
  page_size: 10,
});
console.log(`  ${q.results.length} jobb(er) i "Levert".`);
for (const r of q.results) {
  const tittel = r.properties.Stillingstittel?.title?.[0]?.plain_text ?? '(uten tittel)';
  console.log(`   • ${tittel}`);
}
