// server.js — IA-first + catálogo/brands/envíos/regiones/shopping-list + STOCK (title-first robusto)
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

// Búsqueda con descripción (para puntuar por título y, si falta, por descripción)
async function searchProductsDetailed(query, first = 20){
  const d = await gql(`
    query($q:String!,$n:Int!){
      search(query:$q, types: PRODUCT, first:$n){
        edges{
          node{
            ... on Product {
              title
              handle
              availableForSale
              description
            }
          }
        }
      }
    }
  `,{ q: query, n: first });
  return (d.search?.edges||[]).map(e=>({
    title: e.node.title,
    handle: e.node.handle,
    availableForSale: !!e.node.availableForSale,
    description: e.node.description || ''
  }));
}

// Versión liviana (para otros flujos)
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

/* ----- Shipping regiones/comunas + zonas ----- */
const REGIONES_LIST = [
  'Arica y Parinacota','Tarapacá','Antofagasta','Atacama',
  'Coquimbo','Valparaíso',"O’Higgins","O'Higgins",'Maule','Ñuble','Biobío','Araucanía','Los Ríos','Los Lagos',
  'Metropolitana','Santiago',
  'Aysén','Magallanes'
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
  'alfombra':  ['limpiador alfombra','tapiceria','tapiz','dr beckmann'],
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

/* ----- Búsqueda por título (fallback previo) ----- */
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
  const d = await searchProductsDetailed(String(queryText||'').slice(0,120), 30);
  if (!d.length) return [];
  const kws = extractKeywords(queryText, 10);
  const fld = s => norm(s);
  const scored = d.map(p => {
    const t = fld(p.title);
    const hits = kws.reduce((n,kw)=> n + (t.includes(kw) ? 1 : 0), 0);
    return { ...p, _hits: hits };
  });
  const byHits = scored.sort((a,b)=> b._hits - a._hits);
  const shortlist = byHits.slice(0, max*3);
  const ordered = await preferInStock(shortlist, max);
  return ordered;
}

/* ====== Title-first ROBUSTO ====== */
const STOP_ES = new Set([
  'y','o','u','de','del','la','el','los','las','un','una','unos','unas','para','por','en','con','sin','al',
  'tengo','necesito','quiero','me','recomiendas','recomendar','ayuda','como','cómo','limpiar','limpieza','producto','productos',
  'que','qué','cual','cuál','sobre','mas','más','tipo','tipos','usar','uso'
]);
const rootize = (token='')=>{
  let t = token.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  if (t.endsWith('es') && t.length > 4) t = t.slice(0,-2);
  else if (t.endsWith('s') && t.length > 3) t = t.slice(0,-1);
  return t;
};
const contentTokens = (str='')=> String(str)
  .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g,' ')
  .split(/\s+/)
  .filter(Boolean)
  .map(rootize)
  .filter(t => t.length>=3 && !STOP_ES.has(t));
const bigrams = (tokens)=>{ const out=[]; for (let i=0;i<tokens.length-1;i++) out.push(tokens[i]+' '+tokens[i+1]); return out; };
const jaccard = (aSet, bSet)=>{
  const inter = new Set([...aSet].filter(x=>bSet.has(x))).size;
  const union = new Set([...aSet, ...bSet]).size || 1;
  return inter/union;
};

async function rankByTitleFirst(userText, take=6){
  const toks = contentTokens(userText);
  if (!toks.length) return [];

  const queries = new Set();
  queries.add(String(userText).slice(0,120));
  toks.slice(0,6).forEach(t => queries.add(t));
  bigrams(toks.slice(0,6)).forEach(bg => queries.add(bg));

  const poolMap = new Map(); // handle -> product (with desc)
  for (const q of Array.from(queries).slice(0,14)){
    const found = await searchProductsDetailed(q, 25).catch(()=>[]);
    for (const p of found){
      if (!poolMap.has(p.handle)) poolMap.set(p.handle, p);
    }
  }
  const pool = Array.from(poolMap.values());
  if (!pool.length) return [];

  // Scoring
  const userSet = new Set(toks);
  const userBigrams = new Set(bigrams(toks));
  const scoreTitle = (title='')=>{
    const T = new Set(contentTokens(title));
    let tokHits = 0; for (const t of userSet) if (T.has(t)) tokHits++;
    let biHits = 0; for (const bg of userBigrams) if (new RegExp(`\\b${bg.replace(/\s+/g,'\\s+')}\\b`,'i').test(title)) biHits++;
    const jac = jaccard(userSet, T);
    return { tokHits, biHits, jac, T };
  };
  const scoreDesc = (desc='')=>{
    const D = new Set(contentTokens(desc));
    let tokHits = 0; for (const t of userSet) if (D.has(t)) tokHits++;
    const jac = jaccard(userSet, D);
    return { tokHits, jac };
  };

  const scored = pool.map(p => {
    const st = scoreTitle(p.title||'');
    const sd = scoreDesc(p.description||'');
    // Regla dura de admisión por título:
    //  - tener ≥1 bigrama en título O ≥2 tokens en título
    const passHard = (st.biHits >= 1) || (st.tokHits >= 2);
    // Puntuación compuesta (título manda; descripción ayuda leve)
    const score =
      (p.availableForSale ? 2.0 : 0) +
      st.biHits * 3.0 +
      st.tokHits * 1.2 +
      st.jac * 1.0 +
      (sd.tokHits >= 2 ? 0.6 : 0.0) + // descripción solo empuja un poco
      sd.jac * 0.2;

    return { ...p, _passHard: passHard, _score: score, _st: st };
  });

  // 1) Solo los que pasan la regla dura de título
  let kept = scored.filter(x => x._passHard);
  // Si no alcanza, aflojar a título con ≥1 token y buena jaccard
  if (kept.length < take) {
    const soft = scored
      .filter(x => !x._passHard && x._st.tokHits>=1 && x._st.jac>=0.18)
      .sort((a,b)=> b._score - a._score)
      .slice(0, take*2);
    kept = [...kept, ...soft];
  }
  // Aún bajo? permitir descripción con ≥2 tokens (pero último recurso)
  if (kept.length < take) {
    const descRescue = scored
      .filter(x => !kept.includes(x) && x._st.tokHits===0 && x._score>0.8)
      .slice(0, take*2);
    kept = [...kept, ...descRescue];
  }

  // Orden final: disponible > score
  kept.sort((a,b)=>{
    if (a.availableForSale !== b.availableForSale) return a.availableForSale ? -1 : 1;
    return b._score - a._score;
  });

  const trimmed = kept.slice(0, take);
  return await preferInStock(trimmed, take);
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
        if (pool.length >= max*3) break;
      }
    }
    if (pool.length >= max*3) break;
  }
  return await preferInStock(pool, max);
}

/* ---------- STOCK helpers/intents ---------- */
const STOCK_REGEX = /\b(stock|en\s+stock|stok|disponible|disponibilidad|quedan?|hay|tiene[n]?|inventario)\b/i;

function extractHandleFromText(s=''){
  const m = String(s||'').match(/\/products\/([a-z0-9\-_%.]+)/i);
  return m ? m[1] : null;
}

// Algunas utilidades de stock (marcas solo para sesgar si se mencionan)
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
  for (const tok of tokens){
    if (set.has(tok)) score += 1;
  }
  for (const b of brandTokens){
    const parts = b.split(' ');
    if (parts.every(p => set.has(p))) score += 2;
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

  const scored = pool.map(p => ({
    ...p,
    _score: scoreTitleForStock(p.title, tokens, brandTokens),
  }));

  const good = scored.filter(x => x._score >= 2);
  const list = (good.length ? good : scored)
    .sort((a,b)=>{
      if (a.availableForSale !== b.availableForSale){
        return a.availableForSale ? -1 : 1;
      }
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

    if (toolResult?.id) {
      return res.json({ text: "¡Listo! Producto agregado 👍" });
    }

    const intent = detectIntent(message||'');

    /* ---- STOCK ---- */
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
          return res.json({
            text: `${header}\n${label} ${v.quantityAvailable} ${pluralUnidad(v.quantityAvailable)}`
          });
        }

        if (withQty.length > 1) {
          const lines = withQty.map(v => {
            const name = isDefaultVariantTitle(v.title) ? 'Variante única' : `Variante ${v.title}`;
            return `- ${name}: ${v.quantityAvailable} ${pluralUnidad(v.quantityAvailable)}`;
          });
          return res.json({
            text: `${header}\n**Detalle por variante:**\n${lines.join('\n')}`
          });
        }

        return res.json({
          text: `${header}\n**Stock disponible:** ${qty} ${pluralUnidad(qty)}`
        });
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

    /* ---- Shopping list ---- */
    if (intent === 'shopping'){
      const picks = await selectProductsByOrderedKeywords(message||'');
      if (picks && picks.length){
        return res.json({ text: `Te dejo una opción por ítem:\n\n${buildProductsMarkdown(picks)}` });
      }
      // si no hubo match, sigue con browse
    }

    /* ---- Info/Browse con prioridad título ---- */
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

      // 1) Título estricto
      let items = [];
      try{
        items = await rankByTitleFirst(message||'', 6);
      }catch(e){ console.warn('[rankByTitleFirst] error', e?.message||e); }

      // 2) Fallback: título simple
      if (!items.length){
        try{ items = await titleMatchProducts(message||'', 6); }catch{}
      }

      // 3) Fallback: AI keywords
      if (!items.length){
        try{
          const { keywords, brands, max } = await aiProductQuery(message||'');
          if (keywords.length || brands.length){
            items = await searchByQueries(keywords, brands, Math.min(6, max));
          }
        }catch(err){
          console.warn('[searchByQueries] error', err?.message||err);
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
