// server.js — IA-first + catálogo/brands/envíos/regiones/shopping-list
// + IA→keywords→Shopify + STOCK
// + Ranker reforzado: intención→(boost título exacto)→penalizaciones negativas→descripción
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

const {
  OPENAI_API_KEY,
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_STOREFRONT_TOKEN,
  SHOPIFY_PUBLIC_STORE_DOMAIN,
  ALLOWED_ORIGINS,
  PORT,

  // Negocio
  FREE_SHIPPING_THRESHOLD_CLP, // default 40000 (RM)
  MUNDOPUNTOS_EARN_PER_CLP,
  MUNDOPUNTOS_REDEEM_PER_100,
  MUNDOPUNTOS_PAGE_URL,

  // Opcionales
  BRAND_CAROUSEL_JSON,
  BEST_SELLERS_COLLECTION_HANDLE, // ej. "hogar"
} = process.env;

if (!OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY");
if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_STOREFRONT_TOKEN) throw new Error("Falta SHOPIFY_STORE_DOMAIN o SHOPIFY_STOREFRONT_TOKEN");
if (!SHOPIFY_PUBLIC_STORE_DOMAIN) throw new Error("Falta SHOPIFY_PUBLIC_STORE_DOMAIN");

const app = express();
app.use(express.json({ limit: '1.5mb' }));

const allowed = (ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => (!origin || allowed.includes(origin)) ? cb(null, true) : cb(new Error('Origen no permitido')),
  credentials: true
}));

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* =============== Utils =============== */
const SF_API_VERSION = '2025-01';
const BASE = (SHOPIFY_PUBLIC_STORE_DOMAIN || '').replace(/\/$/, '');
const FREE_TH_DEFAULT = 40000;

const norm = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const fold = s => norm(s).replace(/ñ/g,'n');
const fmtCLP = n => new Intl.NumberFormat('es-CL',{style:'currency',currency:'CLP',maximumFractionDigits:0}).format(Math.round(Number(n)||0));

async function gql(query, variables = {}) {
  const url = `https://${SHOPIFY_STORE_DOMAIN}/api/${SF_API_VERSION}/graphql.json`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type':'application/json', 'X-Shopify-Storefront-Access-Token': SHOPIFY_STOREFRONT_TOKEN},
    body: JSON.stringify({ query, variables })
  });
  if (!r.ok) throw new Error('Storefront API '+r.status);
  const data = await r.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data;
}

/* ----- Catálogo helpers ----- */
async function listCollections(limit = 10){
  const d = await gql(`
    query($n:Int!){ collections(first:$n){ edges{ node{ title handle } } } }
  `,{ n: limit });
  return (d.collections?.edges||[]).map(e=>({ title:e.node.title, handle:e.node.handle }));
}

async function searchProductsPlain(query, first = 5){
  const d = await gql(`
    query($q:String!,$n:Int!){
      search(query:$q, types: PRODUCT, first:$n){
        edges{ node{ ... on Product { title handle availableForSale } } }
      }
    }
  `,{ q: query, n: first });
  return (d.search?.edges||[]).map(e=>({ title:e.node.title, handle:e.node.handle, availableForSale: !!e.node.availableForSale }));
}

async function fetchProductMetaByHandle(handle){
  const d = await gql(`
    query($h:String!){
      productByHandle(handle:$h){
        title
        handle
        availableForSale
        vendor
        description
      }
    }
  `,{ h: handle });
  const p = d.productByHandle;
  if (!p) return null;
  return {
    title: p.title,
    handle: p.handle,
    availableForSale: !!p.availableForSale,
    vendor: p.vendor || '',
    description: p.description || ''
  };
}

async function listTopSellers(first = 8){
  const handle = (BEST_SELLERS_COLLECTION_HANDLE||'').trim();
  if (handle){
    try{
      const d = await gql(`
        query($h:String!,$n:Int!){
          collectionByHandle(handle:$h){
            products(first:$n, sortKey: BEST_SELLING){
              edges{ node{ title handle availableForSale } }
            }
          }
        }
      `,{ h: handle, n:first });
      const items = (d.collectionByHandle?.products?.edges||[]).map(e=>({title:e.node.title,handle:e.node.handle,availableForSale:!!e.node.availableForSale}));
      if (items.length) return items;
      console.warn('[tops] Colección vacía o inválida:', handle);
    }catch(err){ console.warn('[tops] error colección', err?.message||err); }
  }
  try{
    const d = await gql(`
      query($n:Int!){ products(first:$n, sortKey: BEST_SELLING){ edges{ node{ title handle availableForSale } } } }
    `,{ n:first });
    const items = (d.products?.edges||[]).map(e=>({title:e.node.title,handle:e.node.handle,availableForSale:!!e.node.availableForSale}));
    if (items.length) return items;
  }catch(err){ console.warn('[tops] error global', err?.message||err); }
  const any = await gql(`query($n:Int!){ products(first:$n){ edges{ node{ title handle availableForSale } } } }`,{ n:first });
  return (any.products?.edges||[]).map(e=>({title:e.node.title,handle:e.node.handle,availableForSale:!!e.node.availableForSale}));
}

function buildProductsMarkdown(items=[]){
  if (!items.length) return null;
  const lines = items.map((p,i)=>`${i+1}. **[${(p.title||'Ver producto').replace(/\*/g,'')}](${BASE}/products/${p.handle})**`);
  return `Aquí tienes opciones:\n\n${lines.join('\n')}`;
}

async function preferInStock(items, need){
  const inStock = items.filter(x=>x.availableForSale);
  const rest    = items.filter(x=>!x.availableForSale);
  const seen = new Set(); const out = [];
  for (const it of [...inStock, ...rest]){
    if (seen.has(it.handle)) continue;
    seen.add(it.handle);
    out.push(it);
    if (out.length >= need) break;
  }
  return out;
}

/* ===== Ranker: prioriza TÍTULO → penaliza negativos por intención → luego DESCRIPCIÓN ===== */
const STOP = new Set(['de','del','para','con','en','la','el','los','las','y','o','por','una','un','al','lo']);
const toks = s => norm(s).replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w=>w && !STOP.has(w));
const hasPhrase = (haystack, phrase) => norm(haystack).includes(norm(phrase));

function scoreTitle(title, userText){
  const tNorm = norm(title);
  const tks = new Set(toks(title));
  const qs  = toks(userText);
  let s = 0;
  // frase completa
  if (hasPhrase(title, userText)) s += 6;
  // token a token
  for (const q of qs){ if (tks.has(q)) s += 2; }
  // boosts genéricos útiles
  if (tks.has('limpiador')) s += 1;
  if (tks.has('alfombra') && /alfombra|tapicer/.test(norm(userText))) s += 4; // ↑↑
  if ((tks.has('baño') || tks.has('bano') || tks.has('inodoro')) && /(bañ|bano|inodoro|sarro|moho|antihongo)/.test(norm(userText))) s += 4;
  if ((tks.has('quarzo') || tks.has('cuarzo') || tks.has('granito')) && /(quarzo|cuarzo|granito)/.test(norm(userText))) s += 3;

  // penalizaciones (evitamos “vitrocerámica”/“piso madera” para consultas de alfombra/baño)
  if (/(alfombra|tapicer)/.test(norm(userText))) {
    if (/vitroceram/i.test(tNorm)) s -= 6;
    if (/\bmadera\b|\bparquet\b|\blaminado\b/.test(tNorm)) s -= 4;
    if (/\bpiso\b/.test(tNorm)) s -= 3;
  }
  if (/(bañ|bano|inodoro)/.test(norm(userText))) {
    if (/vitroceram/i.test(tNorm)) s -= 6;
    if (/\bmadera\b|\bparquet\b|\blaminado\b/.test(tNorm)) s -= 4;
    if (/\bpiso\b/.test(tNorm)) s -= 3;
  }
  return s;
}

function scoreDesc(desc, userText){
  if (!desc) return 0;
  let s = 0;
  if (hasPhrase(desc, userText)) s += 3;
  const q = toks(userText);
  const d = new Set(toks(desc));
  for (const w of q){ if (d.has(w)) s += 0.5; }
  // ligeras penalizaciones si la descripción habla de superficies equivocadas con intención clara
  const dn = norm(desc);
  if (/(alfombra|tapicer)/.test(norm(userText))) {
    if (/vitroceram/i.test(dn)) s -= 2;
    if (/\bmadera\b|\bparquet\b|\blaminado\b/.test(dn)) s -= 1.5;
  }
  if (/(bañ|bano|inodoro)/.test(norm(userText))) {
    if (/vitroceram/i.test(dn)) s -= 2;
    if (/\bmadera\b|\bparquet\b|\blaminado\b/.test(dn)) s -= 1.5;
  }
  return s;
}

// “Match duro” por intención: prioriza títulos que contengan los términos clave
function hardTitleFilterByIntent(userText, pool){
  const q = norm(userText);
  let re = null;
  if (/(alfombra|tapicer)/.test(q)) {
    re = /(alfombra|tapicer)/i;
  } else if (/(bañ|bano|inodoro|sarro|moho|antihongo)/.test(q)) {
    re = /(bañ|bano|inodoro|sarro|moho|antihong)/i;
  }
  if (!re) return pool;
  const strong = pool.filter(p => re.test(p.title||''));
  // si hay suficientes matches duros, usa eso; si no, mezcla con pool original
  if (strong.length >= 3) return strong.concat(pool).slice(0, Math.max(12, strong.length));
  return pool;
}

async function rankProductsByTitleThenDescription(userText, initialPool){
  if (!initialPool || !initialPool.length) return [];

  // filtro “duro” por intención (si aplica)
  let pool = hardTitleFilterByIntent(userText, initialPool);

  // 1) puntuación por título
  let withTitleScore = pool.map(p => ({ ...p, _t: scoreTitle(p.title||'', userText) }));
  withTitleScore.sort((a,b)=> b._t - a._t);
  let shortlist = withTitleScore.slice(0, 16);

  // 2) enriquecer con descripción si el top no es contundente
  const needDesc = (shortlist[0]?._t || 0) < 6;
  if (needDesc){
    const metas = await Promise.all(shortlist.map(x => fetchProductMetaByHandle(x.handle).catch(()=>null)));
    const metaMap = new Map(); metas.forEach(m => { if (m) metaMap.set(m.handle, m); });
    shortlist = shortlist.map(p => {
      const meta = metaMap.get(p.handle);
      const dScore = meta ? scoreDesc(meta.description||'', userText) : 0;
      return { ...p, _d: dScore };
    });
  } else {
    shortlist = shortlist.map(p => ({ ...p, _d: 0 }));
  }

  // 3) ordenar final: disponible primero, luego título, luego desc
  const ordered = shortlist.sort((a,b)=>{
    if (a.availableForSale !== b.availableForSale) return a.availableForSale ? -1 : 1;
    if (b._t !== a._t) return b._t - a._t;
    return (b._d||0) - (a._d||0);
  });

  return ordered;
}

/* ----- Shipping regiones/comunas + zonas ----- */
const REGIONES_LIST = [
  'Arica y Parinacota','Tarapacá','Antofagasta','Atacama',
  'Coquimbo','Valparaíso',"O’Higgins","O'Higgins",'Maule','Ñuble','Biobío','Araucanía','Los Ríos','Los Lagos',
  'Metropolitana','Santiago','Aysén','Magallanes'
];
const REGIONES_F = new Set(REGIONES_LIST.map(fold));
const COMUNAS = ['Las Condes','Vitacura','Lo Barnechea','Providencia','Ñuñoa','La Reina','Santiago','Macul','La Florida','Puente Alto','Maipú','Maipu','Huechuraba','Independencia','Recoleta','Quilicura','Conchalí','Conchali','San Miguel','San Joaquín','San Joaquin','La Cisterna','San Bernardo','Colina','Buin','Lampa'];
const COMUNAS_F = new Set(COMUNAS.map(fold));

const SHIPPING_ZONES = [
  { zone:'REGIÓN METROPOLITANA', cost:3990,  regions:['Metropolitana','Santiago'] },
  { zone:'ZONA CENTRAL',         cost:6990,  regions:['Coquimbo','Valparaíso','Valparaiso',"O’Higgins","O'Higgins",'Maule','Ñuble','Nuble','Biobío','Biobio','Araucanía','Araucania','Los Ríos','Los Rios','Los Lagos'] },
  { zone:'ZONA NORTE',           cost:10990, regions:['Arica y Parinacota','Tarapacá','Tarapaca','Antofagasta','Atacama'] },
  { zone:'ZONA AUSTRAL',         cost:14990, regions:['Aysén','Aysen','Magallanes'] }
];
const REGION_COST_MAP = (()=>{ const m=new Map(); for(const z of SHIPPING_ZONES) for(const r of z.regions) m.set(fold(r),{zone:z.zone,cost:z.cost}); m.set('metropolitana',{zone:'REGIÓN METROPOLITANA',cost:3990}); m.set('santiago',{zone:'REGIÓN METROPOLITANA',cost:3990}); return m; })();
const shippingByRegionName = (s='') => REGION_COST_MAP.get(fold(s)) || null;

function regionsPayloadLines(){
  const uniq = Array.from(new Set(REGIONES_LIST.map(r=>r.replace(/\"/g,''))));
  return uniq.map(r => `${r}|${r}`).join('\n');
}

/* ----- Shopping list (1 por ítem, mismo orden) ----- */
const SHOPPING_SYNONYMS = {
  'lavalozas': ['lavalozas','lava loza','lavaplatos','dishwashing','lavavajillas liquido','dawn','quix'],
  'antigrasa': ['antigrasa','desengrasante','degreaser','kh-7','kh7'],
  'multiuso':  ['multiuso','all purpose','limpiador multiuso','cif crema','pink stuff'],
  'esponja':   ['esponja','fibra','sponge','scrub daddy'],
  'parrillas': ['limpiador parrilla','bbq','grill','goo gone bbq','desengrasante parrilla'],
  'piso':      ['limpiador pisos','floor cleaner','bona','lithofin'],
  'alfombra':  ['limpiador alfombra','shampoo alfombra','tapiceria','tapiz','dr beckmann alfombra','astonish tapicerias'],
  'vidrio':    ['limpia vidrios','glass cleaner','weiman glass'],
  'acero':     ['limpiador acero inoxidable','weiman acero'],
  'protector textil': ['protector textil','impermeabilizante telas','fabric protector']
};
const tokenize = s => norm(s).replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(Boolean);

function splitShopping(text=''){
  const afterColon = text.split(':');
  const base = afterColon.length > 1 ? afterColon.slice(1).join(':') : text;
  return base.split(/,|\by\b/gi).map(s=>s.trim()).filter(Boolean);
}

async function bestMatchForPhrase(phrase){
  const p = phrase.toLowerCase().trim();
  const syn = SHOPPING_SYNONYMS[p] || [p];
  const pool=[]; const seen=new Set();
  for (const q of syn){
    const found = await searchProductsPlain(q, 10).catch(()=>[]);
    for (const it of found){ if(!seen.has(it.handle)){ seen.add(it.handle); pool.push(it);} }
  }
  if (!pool.length) {
    const tokens = tokenize(phrase).filter(t=>t.length>=3).slice(0,3);
    for(const t of tokens){
      const found = await searchProductsPlain(t, 6).catch(()=>[]);
      for (const it of found){ if(!seen.has(it.handle)){ seen.add(it.handle); pool.push(it);} }
    }
  }
  if (!pool.length) return null;
  return (await preferInStock(pool,1))[0] || pool[0];
}

async function selectProductsByOrderedKeywords(message){
  const parts = splitShopping(message);
  if (parts.length < 2) return null;
  const picks=[]; const used=new Set();
  for (const seg of parts){
    const m = await bestMatchForPhrase(seg);
    if (m && !used.has(m.handle)){ picks.push(m); used.add(m.handle); }
  }
  return picks.length ? picks : null;
}

/* ----- Búsqueda precisa por título (fallback clásico) ----- */
function extractKeywords(text='', max=8){
  const tokens = tokenize(text).filter(t => t.length>=3);
  const stop = new Set(['tienen','venden','quiero','necesito','precio','productos','producto','limpieza','limpiar','ayuda','me','puedes','recomendar','stock','stok','disponible','disponibilidad','quedan','inventario','cuanto','cuánta','cuánta']);
  const bag=[]; const seen=new Set();
  for (const t of tokens){
    if (stop.has(t)) continue;
    const base = t.replace(/s$/,'');
    if (seen.has(base)) continue;
    seen.add(base); bag.push(base);
    if (bag.length>=max) break;
  }
  return bag;
}
async function titleMatchProducts(queryText, max=6){
  const pool = await searchProductsPlain(String(queryText||'').slice(0,120), 24);
  if (!pool.length) return [];
  const kws = extractKeywords(queryText, 10);
  if (!kws.length) return (await preferInStock(pool, max)).slice(0,max);
  const fld = s => norm(s);
  const scored = pool.map(p => {
    const t = fld(p.title);
    const hits = kws.reduce((n,kw)=> n + (t.includes(kw) ? 1 : 0), 0);
    return { ...p, _hits: hits };
  });
  const byHits = scored.sort((a,b)=> b._hits - a._hits).filter(x=>x._hits>0);
  const shortlist = byHits.length ? byHits.slice(0, max*2) : pool.slice(0, max*2);
  const ordered = await preferInStock(shortlist, max);
  return ordered;
}

/* ====== Expansor semántico (más específico) ====== */
function semanticQueryExpansion(text=''){
  const q = norm(text);
  const patterns = [
    { key: 'alfombra', match: /(alfombra|tapiz|tapicer|moqueta)/, queries: ['limpiador alfombra', 'shampoo alfombra', 'limpiador tapiceria', 'dr beckmann alfombra', 'astonish tapicerias'] },
    { key: 'baño',     match: /(bañ|bano|inodoro|ducha|lavamanos|azulejo|sarro|moho|antihongo)/, queries: ['limpiador baño', 'antihongos baño', 'gel inodoro', 'desinfectante baño', 'desincrustante sarro'] },
    { key: 'vidrio',   match: /(vidrio|ventana|cristal)/, queries: ['limpiavidrios', 'weiman glass', 'limpiador vidrio'] },
    { key: 'acero',    match: /(acero|inox)/, queries: ['weiman acero', 'limpiador acero inoxidable'] },
    { key: 'cocina',   match: /(cocina|encimera|horn|grasa)/, queries: ['desengrasante cocina', 'weiman cocina', 'goo gone grill'] },
    { key: 'piedra',   match: /(granito|marmol|cuarzo|quarzo|piedra)/, queries: ['weiman granite', 'limpiador piedra', 'limpiador cuarzo'] },
    { key: 'piso',     match: /(piso|madera|laminado|parquet)/, queries: ['limpiador pisos', 'bona piso', 'weiman piso'] },
  ];
  for (const p of patterns){
    if (p.match.test(q)) return p.queries;
  }
  return null;
}

/* ----- IA (TIP sin CTA) ----- */
const AI_POLICY = `
Eres el asistente de MundoLimpio.cl (Chile), experto en limpieza.
Responde primero con 3–5 bullets (pasos claros y seguros).
NO incluyas CTAs como "¿Te sugiero...?" ni enlaces, marcas o /products/ dentro del TIP.
Tono cercano y breve. No inventes stock, marcas ni precios.
`;

/* ----- IA → intención de productos (keywords/marcas) ----- */
const AI_PRODUCT_QUERY = `
Eres un extractor de intención para una tienda de limpieza en Chile.
Dada la consulta del cliente, responde SOLO con un JSON así:
{"keywords":["antihongos","limpiador baño"],"brands":["Paso"],"max":6}

Reglas:
- "keywords": 2–4 términos (español de Chile) de categoría/superficie/uso.
- "brands": SOLO si el usuario la mencionó (no inventes).
- "max": entre 3 y 8 (por defecto 6).
- Devuelve JSON válido. Nada fuera del JSON.
`;

async function aiProductQuery(userText){
  try{
    const ai = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: AI_PRODUCT_QUERY },
        { role: 'user', content: String(userText||'').slice(0,500) }
      ]
    });
    const raw = (ai.choices?.[0]?.message?.content || '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : raw);
    const keywords = Array.isArray(parsed.keywords) ? parsed.keywords.map(s=>String(s).trim()).filter(Boolean).slice(0,6) : [];
    const brands   = Array.isArray(parsed.brands)   ? parsed.brands.map(s=>String(s).trim()).filter(Boolean).slice(0,3)   : [];
    const max      = Math.max(3, Math.min(8, Number(parsed.max || 6) || 6));
    return { keywords, brands, max };
  }catch(e){
    console.warn('[aiProductQuery] fallo o JSON inválido:', e?.message||e);
    return { keywords: [], brands: [], max: 6 };
  }
}

// Ejecuta varias consultas a Shopify combinando keywords y (si hay) marca
async function searchByQueries(keywords=[], brands=[], max=6){
  const pool=[]; const seen=new Set();

  const queries = [];
  for (const k of keywords){
    queries.push(k);
    for (const b of brands){
      queries.push(`${k} ${b}`);
      queries.push(`${b} ${k}`);
    }
  }
  if (!queries.length && brands.length){
    for (const b of brands) queries.push(b);
  }
  if (!queries.length) return [];

  for (const q of queries.slice(0, 12)){
    const found = await searchProductsPlain(q, 12).catch(()=>[]);
    for (const it of found){
      if (!seen.has(it.handle)){
        seen.add(it.handle);
        pool.push(it);
        if (pool.length >= max*4) break;
      }
    }
    if (pool.length >= max*4) break;
  }
  return pool;
}

/* ---------- STOCK helpers/intents ---------- */
const STOCK_REGEX = /\b(stock|en\s+stock|stok|disponible|disponibilidad|quedan?|hay|tiene[n]?|inventario)\b/i;

function extractHandleFromText(s=''){
  const m = String(s||'').match(/\/products\/([a-z0-9\-_%.]+)/i);
  return m ? m[1] : null;
}

/* ===== Selección de producto para preguntas de stock ===== */
const KNOWN_BRANDS = [
  'astonish','quix','dr beckmann','dr. beckmann','cif','weiman','lithofin',
  'goo gone','scrub daddy','scrub mommy','bona','the good one'
];

function tokenizeStrict(s=''){
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g,' ')
    .split(/\s+/).filter(Boolean);
}

function extractBrandTokens(text=''){
  const q = tokenizeStrict(text).join(' ');
  const hits = [];
  for (const b of KNOWN_BRANDS){
    const needle = b.toLowerCase();
    if (q.includes(needle)) hits.push(needle);
  }
  return Array.from(new Set(hits));
}

function scoreTitleForStock(title='', tokens=[], brandTokens=[]){
  const t = tokenizeStrict(title);
  const set = new Set(t);
  let score = 0;
  for (const tok of tokens){ if (set.has(tok)) score += 1; }
  for (const b of brandTokens){
    const parts = b.split(' ');
    if (parts.every(p => set.has(p))) score += 2;
  }
  if (tokens.includes('pasta') && set.has('pasta')) score += 1;
  if (tokens.includes('multiuso') || tokens.includes('multiusos')){
    if (set.has('multiuso') || set.has('multiusos')) score += 1;
  }
  return score;
}

async function findHandleForStock(message='', meta={}){
  const brandTokens = extractBrandTokens(message);
  const rawTokens = tokenizeStrict(message).filter(w => w.length >= 3);
  const stop = new Set(['la','el','de','del','para','con','una','un','los','las','tienen','tiene','hay','queda','quedan','stock','en','cuanto','cuánta','cuanta','original','producto']);
  const tokens = rawTokens.filter(t => !stop.has(t));

  const queries = [];
  if (brandTokens.length){
    const brand = brandTokens[0];
    if (tokens.length) {
      queries.push(tokens.join(' ') + ' ' + brand);
      queries.push(brand + ' ' + tokens.join(' '));
    } else {
      queries.push(brand);
    }
  }
  if (tokens.length) queries.push(tokens.join(' '));

  if (meta?.page?.url && /\/products\//i.test(meta.page.url)) {
    const m = meta.page.url.match(/\/products\/([a-z0-9\-_%.]+)/i);
    if (m && m[1]) return m[1];
  }

  const seen = new Set();
  const pool = [];
  for (const q of queries.slice(0, 4)){
    if (!q) continue;
    const found = await searchProductsPlain(q, 15).catch(()=>[]);
    for (const it of found){
      if (!seen.has(it.handle)){
        seen.add(it.handle);
        pool.push(it);
      }
    }
  }
  if (!pool.length) return null;

  const scored = pool.map(p => ({ ...p, _score: scoreTitleForStock(p.title, tokens, brandTokens) }));
  const good = scored.filter(x => x._score >= 2);
  const requirePasta = tokens.includes('pasta');
  const candidateList = (requirePasta ? good.filter(x => /pasta/i.test(x.title)) : good);

  const list = (candidateList.length ? candidateList : scored)
    .sort((a,b)=>{
      if (a.availableForSale !== b.availableForSale) return a.availableForSale ? -1 : 1;
      return b._score - a._score;
    });

  return list[0]?.handle || null;
}

// Formatos
function pluralUnidad(n){ return (Number(n) === 1) ? 'unidad' : 'unidades'; }
function pluralDisponible(n){ return (Number(n) === 1) ? 'disponible' : 'disponibles'; }
function isDefaultVariantTitle(t=''){ return /default\s*title/i.test(String(t)); }

/* ----- Intents ----- */
const PURPOSE_REGEX = /\b(para que sirve|para qué sirve|que es|qué es|como usar|cómo usar|modo de uso|instrucciones|paso a paso|como limpiar|cómo limpiar|consejos|tips|guia|guía|pasos)\b/i;

function detectIntent(text=''){
  const q = norm(text);
  const m = String(text||'').match(/^env[ií]o\s+(.+)$/i);
  if (m) {
    const loc = fold(m[1]);
    if (REGIONES_F.has(loc) || COMUNAS_F.has(loc)) return 'shipping_region';
  }

  if (STOCK_REGEX.test(text || '')) return 'stock';
  if (REGIONES_F.has(fold(text)) || COMUNAS_F.has(fold(text))) return 'shipping_region';
  if (/(mas vendidos|más vendidos|best sellers|top ventas|lo mas vendido|lo más vendido)/.test(q)) return 'tops';
  if (/(envio|env[ií]o|despacho|retiro)/.test(q)) return 'shipping';
  if (/(mundopuntos|puntos|fidelizaci[óo]n)/.test(q)) return 'points';
  if (/(que marcas|qué marcas|marcas venden|marcas disponibles)/.test(q)) return 'brands';
  if (/(categorias|categorías|tipos de productos|colecciones|que productos venden|qué productos venden)/.test(q)) return 'categories';
  if (PURPOSE_REGEX.test(text)) return 'info';
  if (/,/.test(text) || /necesito:|lista:|comprar:|quiero:/.test(q)) return 'shopping';
  return 'browse';
}

function parseBrandCarouselConfig(){ try { return JSON.parse(BRAND_CAROUSEL_JSON||''); } catch { return []; } }

/* ====== Storefront stock (sin Admin) ====== */
async function fetchStorefrontStockByHandle(handle){
  const d = await gql(`
    query($h:String!){
      productByHandle(handle:$h){
        title
        variants(first: 100){
          edges{
            node{
              title
              availableForSale
              quantityAvailable
            }
          }
        }
      }
    }
  `, { h: handle });

  const p = d.productByHandle;
  if (!p) return null;

  const variants = (p.variants?.edges || []).map(e => ({
    title: e.node.title || 'Default Title',
    available: !!e.node.availableForSale,
    quantityAvailable: (typeof e.node.quantityAvailable === 'number') ? e.node.quantityAvailable : null,
  }));

  const totals = variants
    .map(v => (typeof v.quantityAvailable === 'number' ? v.quantityAvailable : 0))
    .reduce((a,b)=>a+b,0);

  const hasAnyNumber = variants.some(v => typeof v.quantityAvailable === 'number');
  return {
    title: p.title || 'Producto',
    variants,
    total: hasAnyNumber ? totals : null
  };
}

/* =============== Endpoint =============== */
app.post('/chat', async (req,res)=>{
  try{
    const { message, toolResult, meta={} } = req.body;
    const FREE_TH = Number(FREE_SHIPPING_THRESHOLD_CLP ?? FREE_TH_DEFAULT);

    /* ----------- POST-TOOL HANDLER ----------- */
    if (toolResult?.id) {
      return res.json({ text: "¡Listo! Producto agregado 👍" });
    }

    /* ----------- INTENTS ----------- */
    const intent = detectIntent(message||'');

    /* ---- STOCK (Storefront) ---- */
    if (intent === 'stock') {
      let handle = extractHandleFromText(message || '');

      if (!handle && meta?.page?.url && /\/products\//i.test(meta.page.url)) {
        handle = extractHandleFromText(meta.page.url);
      }

      if (!handle) {
        try { handle = await findHandleForStock(message || '', meta); } catch {}
      }

      if (!handle) {
        try {
          const found = await titleMatchProducts(message || '', 1);
          if (found && found[0]) handle = found[0].handle;
        } catch {}
      }

      if (!handle) {
        return res.json({ text: "Compárteme el **link** del producto o su **nombre exacto** y te digo el stock." });
      }

      const info = await fetchStorefrontStockByHandle(handle);
      if (!info) {
        return res.json({ text: "No encontré ese producto. ¿Puedes confirmarme el nombre o enviar el link?" });
      }

      if (info.total !== null) {
        const qty = info.total;
        const header = `Actualmente contamos con ${qty} ${pluralUnidad(qty)} ${pluralDisponible(qty)} de **${info.title}**.`;
        const withQty = info.variants.filter(v => typeof v.quantityAvailable === 'number');

        if (withQty.length === 1) {
          const v = withQty[0];
          const label = isDefaultVariantTitle(v.title) ? '**Stock disponible:**' : `**Variante ${v.title} — Stock:**`;
          return res.json({ text: `${header}\n${label} ${v.quantityAvailable} ${pluralUnidad(v.quantityAvailable)}` });
        }
        if (withQty.length > 1) {
          const lines = withQty.map(v => {
            const name = isDefaultVariantTitle(v.title) ? 'Variante única' : `Variante ${v.title}`;
            return `- ${name}: ${v.quantityAvailable} ${pluralUnidad(v.quantityAvailable)}`;
          });
          return res.json({ text: `${header}\n**Detalle por variante:**\n${lines.join('\n')}` });
        }
        return res.json({ text: `${header}\n**Stock disponible:** ${qty} ${pluralUnidad(qty)}` });
      }

      const avail = info.variants.filter(v => v.available);
      if (avail.length) {
        const header = `Disponibilidad de **${info.title}**:`;
        const lines = avail.map(v => {
          const name = isDefaultVariantTitle(v.title) ? 'Variante única' : `Variante ${v.title}`;
          return `- ${name}: disponible`;
        });
        return res.json({ text: `${header}\n${lines.join('\n')}` });
      }

      return res.json({ text: `Por ahora **${info.title}** no muestra stock disponible.` });
    }

    /* ---- Más vendidos ---- */
    if (intent === 'tops'){
      const items = await listTopSellers(10).then(xs=>preferInStock(xs,8));
      if (!items.length) return res.json({ text: "Por ahora no tengo un ranking de más vendidos." });
      return res.json({ text: buildProductsMarkdown(items) });
    }

    /* ---- Marcas (BRANDS chips) ---- */
    if (intent === 'brands'){
      const custom = parseBrandCarouselConfig();
      if (custom.length){
        const lines = custom.map(b=>[b.title,b.url,b.image||''].join('|')).join('\n');
        return res.json({ text: `BRANDS:\n${lines}` });
      }
      const d = await gql(`query{ products(first:120){ edges{ node{ vendor } } } }`);
      const vendors = (d.products?.edges||[]).map(e=>String(e.node.vendor||'').trim()).filter(Boolean);
      const top = Array.from(new Set(vendors)).slice(0,48);
      if (top.length){
        const payload = top.map(v=>`${v}|${BASE}/collections/vendors?q=${encodeURIComponent(v)}|`).join('\n');
        return res.json({ text: `BRANDS:\n${payload}` });
      }
      return res.json({ text: 'Trabajamos varias marcas internacionales y locales. ¿Cuál te interesa?' });
    }

    /* ---- Categorías (CATS chips) ---- */
    if (intent === 'categories'){
      const cols = await listCollections(12);
      if (cols.length){
        const payload = cols.map(c=>`${c.title}|${BASE}/collections/${c.handle}`).join('\n');
        return res.json({ text: `CATS:\n${payload}` });
      }
      const fallback = [
        ['LIMPIEZA Y ASEO', `${BASE}/search?q=limpieza`],
        ['LAVADO DE ROPA',  `${BASE}/search?q=ropa`],
        ['CUIDADO PERSONAL',`${BASE}/search?q=personal`],
        ['COCINA',          `${BASE}/search?q=cocina`],
        ['BAÑO',            `${BASE}/search?q=ba%C3%B1o`],
        ['PISOS',           `${BASE}/search?q=pisos`],
      ];
      const payload = fallback.map(([t,u])=>`${t}|${u}`).join('\n');
      return res.json({ text: `CATS:\n${payload}` });
    }

    /* ---- Envíos (general con carrusel REGIONS) ---- */
    if (intent === 'shipping'){
      const header = FREE_TH>0 ? `En **RM** hay **envío gratis** sobre **${fmtCLP(FREE_TH)}**.` : `Hacemos despacho a **todo Chile**.`;
      const general = `El costo se calcula en el **checkout** según **región y comuna**. Elige tu región para ver el costo referencial:`;
      const tarifas =
        `Tarifas por zona:\n`+
        `- **REGIÓN METROPOLITANA**: ${fmtCLP(3990)}\n`+
        `- **ZONA CENTRAL**: ${fmtCLP(6990)} (Coquimbo, Valparaíso, O’Higgins, Maule, Ñuble, Biobío, Araucanía, Los Ríos, Los Lagos)\n`+
        `- **ZONA NORTE**: ${fmtCLP(10990)} (Arica y Parinacota, Tarapacá, Antofagasta, Atacama)\n`+
        `- **ZONA AUSTRAL**: ${fmtCLP(14990)} (Aysén, Magallanes)`;
      const regions = regionsPayloadLines();
      return res.json({ text: `${header}\n${general}\n\nREGIONS:\n${regions}\n\n${tarifas}` });
    }

    /* ---- Envíos (cuando escribe la región/comuna) ---- */
    if (intent === 'shipping_region'){
      const q = String(message||'').trim();
      if (REGIONES_F.has(fold(q)) || /^env[ií]o\s+/i.test(q)) {
        const reg = q.replace(/^env[ií]o\s+/i,'').trim();
        const ship = shippingByRegionName(reg);
        const isRM = /metropolitana|santiago/.test(fold(reg));
        const pieces = [];
        if (ship) pieces.push(`Para **${reg}** (${ship.zone}) el costo referencial es **${fmtCLP(ship.cost)}**.`);
        else pieces.push(`Para **${reg}** el costo se calcula en el checkout por región/comuna.`);
        if (isRM && FREE_TH>0) pieces.push(`En **RM** hay **envío gratis** sobre **${fmtCLP(FREE_TH)}**.`);
        return res.json({ text: pieces.join(' ') });
      }
      if (COMUNAS_F.has(fold(q))){
        return res.json({ text: `Despachamos a **todo Chile**. Para **${q}**, ingresa tu **región/comuna** en el checkout y verás el costo exacto. Si me dices tu **región**, te doy el costo referencial.` });
      }
    }

    /* ---- Mundopuntos ---- */
    if (intent === 'points'){
      const earn = Number(MUNDOPUNTOS_EARN_PER_CLP || 1);
      const redeem100 = Number(MUNDOPUNTOS_REDEEM_PER_100 || 3);
      const url = (MUNDOPUNTOS_PAGE_URL || '').trim();
      return res.json({ text: `**Mundopuntos**: ganas **${earn} punto(s) por $1**. Canje: **100 puntos = ${fmtCLP(redeem100)}**. ${url?`Más info: ${url}`:'Adminístralo en el widget de recompensas.'}` });
    }

    /* ---- Shopping list (varios ítems) ---- */
    if (intent === 'shopping'){
      const picks = await selectProductsByOrderedKeywords(message||'');
      if (picks && picks.length){
        return res.json({ text: `Te dejo una opción por ítem:\n\n${buildProductsMarkdown(picks)}` });
      }
      // si no hubo match, seguimos abajo al flujo general
    }

    /* ---- IA para info (paso a paso) + recomendaciones desde Shopify con ranker ---- */
    if (intent === 'info' || intent === 'browse'){
      let tipText = '';
      try{
        const ai = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: AI_POLICY },
            { role: 'user', content: message || '' }
          ]
        });
        const out = (ai.choices?.[0]?.message?.content || '').trim();
        if (out) tipText = `TIP: ${out}`;
      }catch(err){
        console.warn('[ai] fallo mini plan', err?.message||err);
      }

      let items = [];

      // 0) Expansor semántico
      const semanticQueries = semanticQueryExpansion(message||'');
      if (semanticQueries){
        const pool=[]; const seen=new Set();
        for (const q of semanticQueries){
          const found = await searchProductsPlain(q, 12).catch(()=>[]);
          for (const it of found){ if(!seen.has(it.handle)){ seen.add(it.handle); pool.push(it); } }
        }
        if (pool.length){
          items = await rankProductsByTitleThenDescription(message||'', pool).then(xs=>preferInStock(xs,6));
        }
      }

      // 1) IA → queries → ranker
      if (!items.length){
        try{
          const { keywords, brands, max } = await aiProductQuery(message||'');
          if (keywords.length || brands.length){
            const pool = await searchByQueries(keywords, brands, Math.min(16, Math.max(6, max)));
            if (pool.length){
              const ranked = await rankProductsByTitleThenDescription(message||'', pool);
              items = await preferInStock(ranked, 6);
            }
          }
        }catch(err){ console.warn('[searchByQueries] error', err?.message||err); }
      }

      // 2) Fallback clásico: search plano → ranker
      if (!items.length){
        const pool = await searchProductsPlain(String(message||'').slice(0,120), 24);
        if (pool.length){
          const ranked = await rankProductsByTitleThenDescription(message||'', pool);
          items = await preferInStock(ranked, 6);
        } else {
          items = await titleMatchProducts(message||'', 6);
        }
      }

      const list = items.length ? `\n\n${buildProductsMarkdown(items)}` : '';
      const greet = (meta?.userFirstName && meta?.tipAlreadyShown!==true && Number(meta?.cartSubtotalCLP||0) < Number(FREE_TH||FREE_TH_DEFAULT))
        ? `TIP: Hola, ${meta.userFirstName} 👋 | Te faltan ${fmtCLP(Number(FREE_TH||FREE_TH_DEFAULT) - Number(meta?.cartSubtotalCLP||0))} para envío gratis en RM\n\n`
        : '';

      const finalText = (tipText ? `${greet}${tipText}${list}` : (list || 'No encontré coincidencias exactas. ¿Me das una pista más (marca, superficie, aroma)?'));
      return res.json({ text: finalText });
    }

    return res.json({ text: "¿Me cuentas un poco más? Puedo sugerirte productos o calcular envío por región." });

  }catch(e){
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});

/* ---- Health ---- */
app.get('/health', (_,res)=>res.json({ ok:true }));
const port = PORT || process.env.PORT || 3000;
app.listen(port, ()=>console.log('ML Chat server on :'+port));
