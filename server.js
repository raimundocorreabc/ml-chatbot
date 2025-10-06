// server.js — IA-first + catálogo/brands/envíos/regiones/shopping-list + IA→keywords→Shopify + STOCK
// Ranking mejorado (regla general):
// 1) prioriza TÍTULO por # de coincidencias;
// 2) si empata en título, desempata por DESCRIPCIÓN (desc+tags+vendor+type);
// 3) si ningún título coincide, usa coincidencias en DESCRIPCIÓN.
// Además: pequeños sinónimos genéricos (lejía/bleach/cloro y stickers/calcomanías/adhesivo).

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
const dedup = a => Array.from(new Set(a));

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
        edges{ node{ ... on Product {
          title handle availableForSale vendor productType tags description
        } } }
      }
    }
  `,{ q: query, n: first });
  return (d.search?.edges||[]).map(e=>({
    title: e.node.title,
    handle: e.node.handle,
    availableForSale: !!e.node.availableForSale,
    vendor: (e.node.vendor || ''),
    productType: e.node.productType || '',
    tags: Array.isArray(e.node.tags) ? e.node.tags : [],
    description: e.node.description || ''
  }));
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

/* ----- Shopping synonyms + marcas ----- */
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
  'protector textil': ['protector textil','impermeabilizante telas','fabric protector'],
  'cocina': ['limpiador cocina','limpiador de cocina','antigrasa cocina','desengrasante cocina'],
  'desodorante wc': ['desodorante wc','neutralizador wc','neutralizador olores wc','spray wc','aromatizante wc','desodorante baño wc','dejapoo'],
  'desodorante baño': ['desodorante baño','aromatizante baño','spray baño','neutralizador olores baño','dejapoo'],
  'neutralizador wc': ['neutralizador wc','neutralizador olores wc','desodorante wc','spray wc','dejapoo'],
  'ollas': [
    'pasta multiuso','pink stuff pasta','desengrasante cocina','limpiador acero inoxidable',
    'lavalozas','esponja','fibra','scrub daddy','sarten','cacerola','olla'
  ]
};

const KNOWN_BRANDS = [
  'astonish','weiman','goo gone','dr beckmann','dr. beckmann','kh7','kh-7','bona','lithofin',
  'rexona','febreze','vileda','quix','dejapoo','the pink stuff','pink stuff'
];

/* ----- Tokens ----- */
const tokenize = s => norm(s).replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(Boolean);

const STOPWORDS = new Set([
  'la','el','los','las','de','del','para','por','con','y','o','u','un','una','unos','unas','al','en','mi','tu','su','sus',
  'que','qué','como','cómo','quiero','necesito','recomiendas','recomendar','limpiar','limpieza','mucho','poco','tengo','hay','me','mi','algo','casa','hogar'
].map(norm));

const GENERIC_TOKENS = new Set(['limpiar','limpieza','limpiadores','spray','gatillo']);

function tokenClean(s=''){
  return tokenize(s)
    .map(t=>t.replace(/s$/,''))
    .filter(t=>t.length>=3 && !STOPWORDS.has(t));
}

/* ----- Superficies (algunas lógicas siguen usando esto) ----- */
function detectSurface(text=''){
  const q = norm(text);
  if (/(\bbaño|\bbano|\bwc)\b/.test(q)) return 'bano';
  if (/(\bcocina)\b/.test(q)) return 'cocina';
  if (/(\balfombra|\btapiz|\btapiceria)\b/.test(q)) return 'alfombra';
  if (/(\bpiso|\bpisos|\bparquet|\bflotante)\b/.test(q)) return 'pisos';
  if (/(\bvidrio|\bventana|\bcristal)\b/.test(q)) return 'vidrio';
  if (/(\bmadera)\b/.test(q)) return 'madera';
  if (/(\bacero|\binox|\bacero inoxidable)\b/.test(q)) return 'acero';
  if (/(\bropa|\bpolera|\bcamisa|\bjean|\bzapatilla)\b/.test(q)) return 'ropa';
  if (/(\bolla|\bollas|\bcacerol|\bsarten|\bsart[eé]n|\bsartenes)\b/.test(q)) return 'ollas';
  return null;
}

/* ===== SINÓNIMOS básicos de intención (recall sano) ===== */
const BASIC_SYNONYMS = {
  lejia: ['lejia','cloro','bleach'],
  cloro: ['lejia','cloro','bleach'],
  bleach:['lejia','cloro','bleach'],
  sticker:['sticker','stickers','calcomania','calcomanias','etiqueta','etiquetas','adhesivo','adhesivos','pegatina','pegatinas','pegamento','residuo','residuos']
};

function expandSynonyms(tokens){
  const out = new Set();
  for (const t of tokens){
    out.add(t);
    const syns = BASIC_SYNONYMS[t];
    if (syns) for (const s of syns) out.add(norm(s));
  }
  return Array.from(out);
}

function productTextPieces(p){
  return {
    title: norm(p.title||''),
    desc : norm(p.description||''),
    tags : norm((p.tags||[]).join(' ')),
    vendor: norm(p.vendor||''),
    type: norm(p.productType||'')
  };
}

function countHitsIn(text, tokens){
  let n = 0; for (const tok of tokens){ if (tok && text.includes(tok)) n++; }
  return n;
}

/* ===== body queries (para fallbacks) ===== */
const BODY_EXCLUDE = new Set([
  // funcionales
  'el','la','los','las','un','una','unos','unas','de','del','al','a','en','con','por','para','sin','sobre','entre','tras','desde','hasta','hacia',
  'y','e','o','u','ni','que','como','donde','cuando','cual','cuales','cuyo','cuya','cuyos','cuyas','este','esta','estos','estas','ese','esa','esos','esas','aquel','aquella','aquellos','aquellas',
  'lo','le','les','se','me','te','nos','os','su','sus','mi','mis','tu','tus','nuestro','nuestra','nuestros','nuestras',
  'si','no','ya','aun','aún','tambien','también','ademas','mas','más','menos','muy','quiza','quizas','tal','tan','tanto',
  // uso/marketing/rubro
  'uso','usar','utilizar','empleo','metodo','método','modo','forma','manera','paso','pasos','guia','guía','instruccion','instrucción','instrucciones',
  'recomendacion','recomendación','recomendado','recomendada','sirve','servir','ayuda','ayudar','permite','permitir','aplicar','aplicacion','aplicación','aplicado','aplicada',
  'agitar','verter','diluir','enjuagar','enjuague','secar','frotar','rociar','pulverizar','repetir','dejar','esperar',
  'mejor','eficaz','efectivo','eficiente','potente','rapido','rápido','seguro','confiable','durable','duradero','resistente',
  'profesional','avanzado','original','nuevo','nueva','innovador','innovadora','superior','alto','alta','maxima','máxima','optimo','óptimo','optima','óptima','excelente','ideal','especial','adecuado','adecuada','versatil','versátil','facil','fácil','practico','práctico',
  'limpieza','limpiar','aseo','hogar','casa','superficie','superficies','producto','productos','solucion','solución','formula','fórmula','contenido','contiene','elimina','remueve','quita','protege','cuida','actua','actúa','reduce','previene',
  // formatos
  'ml','l','lt','litro','litros','g','gr','kg','kilo','kilos','oz','onzas','cm','mm','m','unidad','unidades','pack','set','formato','tamaño','tamano','presentacion','presentación',
  'x','por','c/u','aprox','1','2','3','4','5','6','7','8','9','0','250','300','355','400','500','650','700','710','750','946','950','1000','3780','3.78',
  // e-commerce/operativas
  'oferta','promo','promoción','promocion','descuento','rebaja','precio','precios','normal','ahora','envio','envío','despacho','stock','disponible','disponibilidad','garantia','garantía',
  'caja','cajas','codigo','código','sku','ref','referencia',
  // conectores
  'hecho','fabricado','fabricada','desarrollado','desarrollada','diseñado','diseñada','compatible','diario','cotidiano','multiuso','multi-uso','multiusos','multi-usos','domestico','doméstico','industrial'
].map(norm));

function bodyQueriesFromText(text=''){
  const raw = tokenClean(text);
  const toks = raw.filter(t => !BODY_EXCLUDE.has(t) && !/^\d+(?:[.,]\d+)?$/.test(t));
  if (!toks.length) return [];
  const qs = [];
  qs.push(toks.map(t => `body:${t}`).join(' '));
  for (const t of toks) qs.push(`body:${t}`);
  qs.push(toks.join(' '));
  for (const t of toks) qs.push(t);
  const phrase = String(text||'').trim();
  if (phrase.length>=6){
    const ph = phrase.slice(0,100);
    qs.push(`body:"${ph}"`);
    qs.push(`"${ph}"`);
  }
  const out=[], seen=new Set();
  for (const q of qs){
    const k = q.trim(); if (!k || seen.has(k)) continue;
    seen.add(k); out.push(k);
    if (out.length>=12) break;
  }
  return out;
}

/* ===== Ranker principal (tu regla general aplicada) ===== */
async function buildPoolByQueries(queries, cap=100){
  const pool=[]; const seen=new Set();
  for (const q of queries){
    const found = await searchProductsPlain(q, 18).catch(()=>[]);
    for (const it of found){
      if (seen.has(it.handle)) continue;
      seen.add(it.handle);
      pool.push(it);
      if (pool.length >= cap) return pool;
    }
  }
  return pool;
}

async function recommendByTitleFirst(userText, max = 6){
  // 0) tokens limpios + sinónimos cortos
  const raw = tokenClean(userText).filter(t => !GENERIC_TOKENS.has(t));
  const tokens = expandSynonyms(dedup(raw));
  if (!tokens.length) return [];

  // 1) Pool: primero TÍTULO; si vacío, BODY
  const titleQueries = dedup([
    tokens.join(' '),
    ...tokens.map(t => `title:${t}`),
    ...tokens
  ]);
  let pool = await buildPoolByQueries(titleQueries, 120);

  if (!pool.length){
    const bodyQs = dedup([
      tokens.map(t => `body:${t}`).join(' '),
      ...tokens.map(t => `body:${t}`)
    ]);
    pool = await buildPoolByQueries(bodyQs, 90);
  }
  if (!pool.length) return [];

  // 2) Score: #hits en título (_th) y en descripción agregada (_dh)
  const scored = pool.map(p => {
    const { title, desc, tags, vendor, type } = productTextPieces(p);
    const descAll = `${desc} ${tags} ${vendor} ${type}`;
    const th = countHitsIn(title, tokens);
    const dh = countHitsIn(descAll, tokens);
    return { ...p, _th: th, _dh: dh };
  });

  // 3) Si hay coincidencia en TÍTULO, usamos solo esos; desempate por desc
  const titleMatched = scored.filter(x => x._th > 0);
  if (titleMatched.length){
    return titleMatched
      .sort((a,b)=>{
        if (a.availableForSale !== b.availableForSale) return a.availableForSale ? -1 : 1;
        if (a._th !== b._th) return b._th - a._th;
        if (a._dh !== b._dh) return b._dh - a._dh;
        return (a.title||'').length - (b.title||'').length;
      })
      .slice(0, max);
  }

  // 4) Si NADIE coincide en título, rankeamos por DESCRIPCIÓN
  const descMatched = scored.filter(x => x._dh > 0);
  if (descMatched.length){
    return descMatched
      .sort((a,b)=>{
        if (a.availableForSale !== b.availableForSale) return a.availableForSale ? -1 : 1;
        if (a._dh !== b._dh) return b._dh - a._dh;
        return 0;
      })
      .slice(0, max);
  }

  // 5) Último recurso
  return (await preferInStock(pool, max)).slice(0, max);
}

/* ----- Búsqueda precisa por título (fallback simple) ----- */
function extractKeywords(text='', max=8){
  const tokens = tokenize(text).filter(t => t.length>=3);
  const stop = new Set(['tienen','venden','quiero','necesito','precio','productos','producto','limpieza','limpiar','ayuda','me','puedes','recomendar','stock','stok','disponible','disponibilidad','quedan','inventario','cuanto','cuánta','cuanta','limpio','mucho','poco'].map(norm));
  const bag=[]; const seen=new Set();
  for (const t of tokens){
    if (stop.has(t)) continue;
    const base = t.replace(/s$/,''); // singularización simple
    if (seen.has(base)) continue;
    seen.add(base); bag.push(base);
    if (bag.length>=max) break;
  }
  return bag;
}
async function titleMatchProducts(queryText, max=6){
  const pool = await searchProductsPlain(String(queryText||'').slice(0,120), 36);
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
  const ordered = shortlist.sort((a,b)=>{
    if (a.availableForSale !== b.availableForSale) return a.availableForSale ? -1 : 1;
    return (b._hits||0) - (a._hits||0);
  }).slice(0, max);
  return ordered;
}

/* ----- Shopping list: usa el mismo ranker por segmento ----- */
function splitShopping(text=''){
  const afterColon = text.split(':');
  const base = afterColon.length > 1 ? afterColon.slice(1).join(':') : text;
  return base.split(/,|\by\b/gi).map(s=>s.trim()).filter(Boolean);
}

async function bestMatchForPhrase(phrase){
  const items = await recommendByTitleFirst(phrase, 3);
  return items[0] || null;
}

async function selectProductsByOrderedKeywords(message){
  const parts = splitShopping(message||'');
  if (parts.length < 2) return null;
  const picks=[]; const used=new Set();
  for (const seg of parts){
    const m = await bestMatchForPhrase(seg);
    if (m && !used.has(m.handle)){ picks.push(m); used.add(m.handle); }
  }
  return picks.length ? picks : null;
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
    const keywords = Array.isArray(parsed.keywords)
      ? parsed.keywords.map(s=>String(s).trim()).filter(Boolean).filter(k=>!GENERIC_TOKENS.has(norm(k))).slice(0,6)
      : [];
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
    if (!k || GENERIC_TOKENS.has(norm(k))) continue;
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
  return pool.sort((a,b)=>{
    if (a.availableForSale !== b.availableForSale) return a.availableForSale ? -1 : 1;
    return 0;
  }).slice(0, max);
}

/* ---------- STOCK helpers/intents ---------- */
// ⚠️ Menos agresivo: quitamos "hay" y "tiene[n]?"
const STOCK_REGEX = /\b(stock|en\s+stock|stok|disponible|disponibilidad|quedan?|inventario)\b/i;

function extractHandleFromText(s=''){
  const m = String(s||'').match(/\/products\/([a-z0-9\-_%\.]+)/i);
  return m ? m[1] : null;
}

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
    const m = meta.page.url.match(/\/products\/([a-z0-9\-_%\.]+)/i);
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
  const requirePasta = tokens.includes('pasta');
  const candidateList = (requirePasta ? good.filter(x => /pasta/i.test(x.title)) : good);

  const list = (candidateList.length ? candidateList : scored)
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

  // Si viene "envío <lugar>", rutear a shipping_region
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

  // Shopping list robusto: no por una sola coma casual
  const commaCount = (text.match(/,/g) || []).length;
  const looksLikeRealList = /\b\w+\b\s*,\s*\b\w+\b\s*(?:,|\by\b)\s*\b\w+\b/i.test(text);
  if (/(necesito:|lista:|comprar:|quiero:)/.test(q) || commaCount >= 2 || looksLikeRealList) return 'shopping';

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
        try {
          handle = await findHandleForStock(message || '', meta);
        } catch {}
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
        ['BAÑO',            `${BASE}/search?q=${encodeURIComponent('baño')}`],
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
      // si no hubo match, caemos a recomendación normal
    }

    /* ---- IA para info (paso a paso) + recomendaciones — RANKING nuevo ---- */
    if (intent === 'info' || intent === 'browse'){
      // 1) Recomendación por TÍTULO>DESCRIPCIÓN
      let items = [];
      try {
        items = await recommendByTitleFirst(message||'', 6);
      } catch (err) {
        console.warn('[recommendByTitleFirst] error', err?.message||err);
      }

      // 2) Si no hubo resultados, IA→keywords/brands (secundario)
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

      // 3) Fallback por descripción (BODY) si aún nada
      if (!items.length){
        const bqs = bodyQueriesFromText(message||'');
        const seen = new Set(); const bodyPool = [];
        for (const q of bqs){
          const found = await searchProductsPlain(q, 18).catch(()=>[]);
          for (const it of found){
            if (!seen.has(it.handle)){
              seen.add(it.handle);
              bodyPool.push(it);
              if (bodyPool.length >= 36) break;
            }
          }
          if (bodyPool.length >= 36) break;
        }
        items = bodyPool.slice(0,6);
      }

      // 4) TIP (consejos)
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

      const list = (items && items.length)
        ? `\n\n${buildProductsMarkdown(items)}`
        : '';

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
