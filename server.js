// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

/* =========================
   ENV & CONFIG
   ========================= */
const {
  OPENAI_API_KEY,
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_STOREFRONT_TOKEN,
  SHOPIFY_PUBLIC_STORE_DOMAIN,
  ALLOWED_ORIGINS,
  PORT,

  // Config FAQs
  FREE_SHIPPING_THRESHOLD_CLP, // default 40000 (RM)
  MUNDOPUNTOS_EARN_PER_CLP,
  MUNDOPUNTOS_REDEEM_PER_100,
  MUNDOPUNTOS_PAGE_URL,

  // Carrusel de marcas (opcional): JSON de [{title,url,image}]
  BRAND_CAROUSEL_JSON
} = process.env;

if (!OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY");
if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_STOREFRONT_TOKEN) throw new Error("Falta SHOPIFY_STORE_DOMAIN o SHOPIFY_STOREFRONT_TOKEN");
if (!SHOPIFY_PUBLIC_STORE_DOMAIN) throw new Error("Falta SHOPIFY_PUBLIC_STORE_DOMAIN");

const SF_API_VERSION = '2025-07';
const BASE = (SHOPIFY_PUBLIC_STORE_DOMAIN || '').replace(/\/$/, '');
const FREE_TH_DEFAULT = 40000; // RM sobre $40.000

/* =========================
   APP & MIDDLEWARES
   ========================= */
const allowed = (ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

const app = express();
app.use(express.json({ limit: '1.2mb' }));
app.use(cors({
  origin: (origin, cb) => (!origin || allowed.includes(origin)) ? cb(null, true) : cb(new Error('Origen no permitido')),
  credentials: true
}));

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* =========================
   UTILS
   ========================= */
function formatCLP(n) {
  const v = Math.round(Number(n) || 0);
  return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(v);
}
const norm = (s='') => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const fold = (s='') => norm(s).replace(/ñ/g,'n');
function stripAndTrim(s = '') {
  return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function titleCaseComuna(s) { return String(s||'').toLowerCase().replace(/\b\w/g, m => m.toUpperCase()); }

/* ---------- Política IA (guardrails) ---------- */
const AI_RESPONSE_POLICY = `
Eres un experto en limpieza en Chile para MundoLimpio.cl.
SIEMPRE responde primero con un mini plan práctico (máx 5 bullets) y luego, solo si ayuda, sugiere 2–3 productos relevantes.
No inventes enlaces, precios ni disponibilidad. No inventes marcas/modelos.
Para preguntas de “para qué sirve”, “cómo se usa”, “manchas/olores/pasos”, prioriza guía clara y segura (prueba en zona oculta, guantes, ventilación cuando aplique).
Si es lista de compras, sugiere 1 producto por ítem en el mismo orden.
Tono: claro, cercano (chile), breve. CTA suave al final si corresponde.
`;

// Detecta consultas informativas (ampliado)
const PURPOSE_REGEX = /\b(para que sirve|para qué sirve|que es|qué es|como usar|cómo usar|modo de uso|instrucciones|paso a paso|como limpiar|cómo limpiar|consejos|guia|guía|pasos|manual)\b/i;

/* ---------------- Regiones y comunas (para intención "envío") ---------------- */
const REGIONES = [
  'arica y parinacota','tarapaca','antofagasta','atacama','coquimbo','valparaiso',
  'metropolitana','santiago',"o'higgins",'ohiggins','maule','nuble','biobio',
  'la araucania','araucania','los rios','los lagos','aysen','magallanes'
];
const REGIONES_FOLDED = new Set(REGIONES.map(fold));

const COMUNAS = [
  'las condes','vitacura','lo barnechea','providencia','ñuñoa','la reina','peñalolén','santiago',
  'macul','la florida','puente alto','maipú','huechuraba','independencia','recoleta','quilicura',
  'conchalí','san miguel','san joaquín','la cisterna','san bernardo','colina','buin','lampa'
];
const COMUNAS_FOLDED = new Set(COMUNAS.map(fold));

/* ---------------- Tarifas de envío por zona ---------------- */
const SHIPPING_ZONES = [
  { zone: 'REGIÓN METROPOLITANA', cost: 3990,  regions: ['Metropolitana','Santiago'] },
  { zone: 'ZONA CENTRAL',         cost: 6990,  regions: ['Coquimbo','Valparaíso','Valparaiso',"O’Higgins","O'Higgins",'Maule','Ñuble','Nuble','Biobío','Biobio','Araucanía','Araucania','Los Ríos','Los Rios','Los Lagos'] },
  { zone: 'ZONA NORTE',           cost: 10990, regions: ['Arica y Parinacota','Tarapacá','Tarapaca','Antofagasta','Atacama'] },
  { zone: 'ZONA AUSTRAL',         cost: 14990, regions: ['Aysén','Aysen','Magallanes'] }
];
const REGION_COST_MAP = (() => {
  const m = new Map();
  for (const z of SHIPPING_ZONES) for (const r of z.regions) m.set(fold(r), { zone: z.zone, cost: z.cost });
  m.set('metropolitana', { zone: 'REGIÓN METROPOLITANA', cost: 3990 });
  m.set('santiago',      { zone: 'REGIÓN METROPOLITANA', cost: 3990 });
  return m;
})();
function shippingByRegionName(input='') { return REGION_COST_MAP.get(fold(input)) || null; }

/* =========================
   SHOPIFY HELPERS
   ========================= */
async function shopifyStorefrontGraphQL(query, variables = {}) {
  const url = `https://${SHOPIFY_STORE_DOMAIN}/api/${SF_API_VERSION}/graphql.json`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': SHOPIFY_STOREFRONT_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  if (!r.ok) throw new Error('Storefront API ' + r.status);
  const data = await r.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data;
}

async function getProductJsonByHandle(handle) {
  const url = `${BASE}/products/${handle}.js`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('No se pudo leer ' + url);
  return r.json();
}

async function getProductDetailsByHandle(handle) {
  const data = await shopifyStorefrontGraphQL(`
    query ProductByHandle($h: String!) {
      product(handle: $h) {
        title
        handle
        description
        availableForSale
      }
    }
  `, { h: handle });
  return data.product || null;
}

async function searchProductsPlain(query, first = 5) {
  const data = await shopifyStorefrontGraphQL(`
    query SearchProducts($q: String!, $n: Int!) {
      search(query: $q, types: PRODUCT, first: $n) {
        edges { node { ... on Product { title handle availableForSale } } }
      }
    }
  `, { q: query, n: first });
  return (data.search?.edges || []).map(e => ({
    title: e.node.title, handle: e.node.handle, availableForSale: !!e.node.availableForSale
  }));
}

async function listTopSellers(first = 5) {
  // 1) Global BEST_SELLING
  try {
    const data = await shopifyStorefrontGraphQL(`
      query TopSellers($n: Int!) {
        products(first: $n, sortKey: BEST_SELLING) {
          edges { node { title handle availableForSale } }
        }
      }
    `, { n: first });
    const items = (data.products?.edges || []).map(e => ({ title: e.node.title, handle: e.node.handle, availableForSale: !!e.node.availableForSale }));
    if (items.length) return items;
  } catch {}

  // 2) Colección "all"
  try {
    const dataAll = await shopifyStorefrontGraphQL(`
      query TopSellersAll($n:Int!){
        collectionByHandle(handle:"all"){
          products(first:$n, sortKey: BEST_SELLING){
            edges{ node{ title handle availableForSale } }
          }
        }
      }
    `, { n: first });
    const itemsAll = (dataAll.collectionByHandle?.products?.edges || []).map(e => ({ title: e.node.title, handle: e.node.handle, availableForSale: !!e.node.availableForSale }));
    if (itemsAll.length) return itemsAll;
  } catch {}

  // 3) Último recurso
  const any = await shopifyStorefrontGraphQL(`
    query Any($n:Int!){
      products(first:$n){
        edges{ node{ title handle availableForSale } }
      }
    }
  `, { n: first });
  return (any.products?.edges || []).map(e => ({ title: e.node.title, handle: e.node.handle, availableForSale: !!e.node.availableForSale }));
}

async function searchByVendor(vendor, first = 5) {
  const data = await shopifyStorefrontGraphQL(`
    query ByVendor($q: String!, $n: Int!) {
      products(first: $n, query: $q) {
        edges { node { title handle vendor availableForSale } }
      }
    }
  `, { q: `vendor:"${vendor}"`, n: first });
  return (data.products?.edges || []).map(e => ({ title: e.node.title, handle: e.node.handle, availableForSale: !!e.node.availableForSale }));
}

/* --- vendors y colecciones --- */
async function listVendors(limit = 20) {
  const data = await shopifyStorefrontGraphQL(`
    query Vendors {
      products(first: 100) { edges { node { vendor } } }
    }
  `);
  const vendors = (data.products?.edges || [])
    .map(e => (e.node.vendor || '').trim())
    .filter(Boolean);
  const freq = new Map();
  for (const v of vendors) freq.set(v, (freq.get(v) || 0) + 1);
  return [...freq.entries()].sort((a,b) => b[1]-a[1]).map(([v]) => v).slice(0, limit);
}

async function listCollections(limit = 10) {
  const data = await shopifyStorefrontGraphQL(`
    query Colls($n:Int!) {
      collections(first: $n) { edges { node { title handle } } }
    }
  `, { n: limit });
  return (data.collections?.edges || []).map(e => ({ title: e.node.title, handle: e.node.handle }));
}

/* =========================
   RANK & STOCK HELPERS
   ========================= */
async function productAvailableForSale(handle){
  const d = await shopifyStorefrontGraphQL(`
    query($h:String!){ product(handle:$h){ availableForSale } }
  `, { h: handle });
  return !!d.product?.availableForSale;
}
async function markAvailability(items){
  const checks = await Promise.all(items.map(it =>
    productAvailableForSale(it.handle).catch(()=>false)
  ));
  return items.map((it,i)=>({...it, inStock: checks[i]}));
}
async function preferInStock(items, need){
  const marked = await markAvailability(items);
  const inStock = marked.filter(x=>x.inStock);
  const rest    = marked.filter(x=>!x.inStock);
  // quitar duplicados por handle
  const dedup = [];
  const seen = new Set();
  for (const p of inStock.concat(rest)) {
    if (seen.has(p.handle)) continue;
    seen.add(p.handle);
    dedup.push(p);
  }
  return dedup.slice(0, need).map(({inStock, ...p})=>p);
}

/* =========================
   KEYWORDS & MATCH
   ========================= */
const ES_STOPWORDS = new Set([
  'el','la','los','las','un','una','unos','unas','de','del','al','a','en','y','o','u','para',
  'por','con','sin','que','qué','cual','cuál','como','cómo','donde','dónde','sobre','mi','mis',
  'tu','tus','su','sus','lo','le','les','me','te','se','es','son','ser','estar','hay',
  'quiero','necesito','recomendar','recomendacion','recomendación','productos','producto',
  'limpiar','limpieza','comprar','ayuda','debo','deberia','debería'
].map(s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()));

function extractKeywords(text='', max=6){
  const tokens = String(text||'')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúüñ\s]/gi,' ')
    .split(/\s+/)
    .filter(Boolean);
  const bag = [];
  const seen = new Set();
  for (const t of tokens) {
    if (t.length < 3) continue;
    const base = t.replace(/s$/,'');
    if (ES_STOPWORDS.has(base)) continue;
    if (seen.has(base)) continue;
    seen.add(base);
    bag.push(base);
    if (bag.length >= max) break;
  }
  return bag;
}

async function titleMatchProducts(queryText, max=5){
  const pool = await searchProductsPlain(String(queryText||'').slice(0,120), 20);
  if (!pool.length) return [];

  const kws = extractKeywords(queryText, 8);
  if (!kws.length) return preferInStock(pool, max);

  const fld = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const scored = pool.map(p => {
    const t = fld(p.title);
    const hits = kws.reduce((n,kw)=> n + (t.includes(kw) ? 1 : 0), 0);
    return { ...p, _hits: hits };
  });

  const byHits = scored.sort((a,b)=> b._hits - a._hits).filter(x=>x._hits > 0).slice(0, max*2);
  if (!byHits.length) return preferInStock(pool, max);

  return await preferInStock(byHits, max);
}

/* =========================
   LISTA DE COMPRAS
   ========================= */
const SHOPPING_SYNONYMS = {
  'lavalozas': ['lavalozas','lava loza','lavaplatos','dishwashing','lavavajillas liquido','lavavajilla'],
  'antigrasa': ['antigrasa','desengrasante','degreaser'],
  'multiuso': ['multiuso','multi usos','multiusos','limpiador multiuso','all purpose'],
  'parrillas': ['parrilla','bbq','grill','barbacoa'],
  'esponja': ['esponja','fibra','sponge','scour'],
};
function splitShoppingPhrases(text=''){
  return String(text).toLowerCase().split(/,| y /g).map(s => s.trim()).filter(Boolean);
}
function tokenizeSimple(s=''){
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    .replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(t => t.length >= 3);
}
function scoreTitleByTokens(title='', tokens=[]){
  if (!title) return 0;
  const t = tokenizeSimple(title);
  const bag = new Set(t);
  let hits = 0;
  for (const w of tokens) if (bag.has(w)) hits++;
  for (let i=0; i<tokens.length-1; i++){
    const bi = tokens[i] + ' ' + tokens[i+1];
    if (title.toLowerCase().includes(bi)) hits += 0.5;
  }
  return hits;
}
async function searchMulti(queries = [], max = 5) {
  const picks = [];
  const seen = new Set();
  for (const q of queries) {
    const found = await searchProductsPlain(q, 3);
    for (const it of found) {
      if (!seen.has(it.handle)) {
        seen.add(it.handle);
        picks.push(it);
        if (picks.length >= max) return picks;
      }
    }
  }
  return picks;
}
async function bestMatchForPhrase(phrase){
  const p = phrase.trim().toLowerCase();
  const syn = SHOPPING_SYNONYMS[p] || [p];
  const pool = [];
  const seen = new Set();
  for (const q of syn) {
    const found = await searchProductsPlain(q, 12).catch(()=>[]);
    for (const it of found) {
      if (!seen.has(it.handle)) { seen.add(it.handle); pool.push(it); }
    }
  }
  if (!pool.length) return null;
  const tokens = tokenizeSimple(phrase);
  const scored = pool.map(pp => ({ ...pp, _score: scoreTitleByTokens(pp.title, tokens) }))
                     .filter(x => x._score > 0)
                     .sort((a,b) => b._score - a._score);
  const shortlist = scored.length ? scored.slice(0, 8) : pool.slice(0, 8);
  const ordered = await preferInStock(shortlist, 1);
  return ordered[0] || null;
}
async function selectProductsByOrderedKeywords(message, maxExtras=0){
  const parts = splitShoppingPhrases(message);
  if (parts.length < 2 && tokenizeSimple(message).length < 2) return null;

  const picks = [];
  const used = new Set();

  for (const seg of parts) {
    const m = await bestMatchForPhrase(seg);
    if (m && !used.has(m.handle)) { picks.push(m); used.add(m.handle); }
  }

  if (maxExtras > 0) {
    const extra = await titleMatchProducts(message, maxExtras);
    for (const it of extra) {
      if (!used.has(it.handle)) { picks.push(it); used.add(it.handle); }
      if (picks.length >= parts.length + maxExtras) break;
    }
  }
  return picks.length ? picks : null;
}

/* =========================
   TEXTO/OUTPUT HELPERS
   ========================= */
function buildProductsMarkdown(items = []) {
  if (!items.length) return null;
  const lines = items.map((p, i) => {
    const safeTitle = (p.title || 'Ver producto').replace(/\*/g, '');
    return `${i + 1}. **[${safeTitle}](${BASE}/products/${p.handle})** – ver detalles o agregar al carrito.`;
  });
  return `Aquí tienes opciones:\n\n${lines.join('\n')}`;
}
function maybePrependGreetingTip(text, meta, FREE_TH) {
  const name = (meta?.userFirstName || '').trim();
  const already = !!meta?.tipAlreadyShown;
  if (!name || already) return text;

  const sub = Number(meta?.cartSubtotalCLP || 0);
  const hasCart = Number.isFinite(sub) && sub > 0;
  const extra = (hasCart && FREE_TH > 0 && sub < FREE_TH) ? ` | Te faltan ${formatCLP(FREE_TH - sub)} para envío gratis en RM` : '';
  return `TIP: Hola, ${name} 👋${extra}\n\n${text}`;
}
function parseBrandCarouselConfig() { try { return JSON.parse(BRAND_CAROUSEL_JSON || ''); } catch { return []; } }
function buildBrandsPayload(brands = []) {
  if (!brands.length) return null;
  const rows = brands.map(b => {
    const title = (b.title || '').trim();
    const url   = (b.url   || '').trim();
    const image = (b.image || '').trim();
    if (!title || !url) return null;
    return [title, url, image].join('|');
  }).filter(Boolean);
  return rows.length ? `BRANDS:\n${rows.join('\n')}` : null;
}

/* =========================
   TIPS PREARMADOS
   ========================= */
async function tipVitro() {
  const tip = [
    'Vitrocerámica — pasos rápidos:',
    '1) Con la placa fría, retira residuos con rasqueta plástica.',
    '2) Aplica crema específica 1–2 min.',
    '3) Pasa microfibra; repite en manchas quemadas.',
    '4) Termina con protector/abrillantador si quieres más brillo.'
  ].join('\n');
  const items = await searchMulti(['weiman vitroceramica crema', 'weiman cook top kit', 'astonish vitroceramica'], 3);
  const list = buildProductsMarkdown(items);
  return list ? `TIP: ${tip}\n\n${list}` : `TIP: ${tip}`;
}
async function tipAlfombra() {
  const tip = [
    'Alfombra — limpieza básica:',
    '1) Aspira a fondo (pasadas cruzadas).',
    '2) Prueba el producto en zona oculta.',
    '3) Aplica limpiador de alfombras, cepilla suave y retira.',
    '4) Seca con ventilación; repite si persiste la mancha.'
  ].join('\n');
  const items = await searchMulti(['alfombra limpiador', 'tapicerias astonish', 'protector textil'], 3);
  const list = buildProductsMarkdown(items);
  return list ? `TIP: ${tip}\n\n${list}` : `TIP: ${tip}`;
}
async function tipCortina() {
  const tip = [
    'Cortina tela — cuidado rápido:',
    '1) Aspira el polvo con boquilla suave.',
    '2) Mancha puntual: quitamanchas de telas.',
    '3) Lava según etiqueta o en seco.',
    '4) Protege con spray anti manchas si es habitual.'
  ].join('\n');
  const items = await searchMulti(['quitamanchas tela', 'protector textil', 'limpiador telas'], 3);
  const list = buildProductsMarkdown(items);
  return list ? `TIP: ${tip}\n\n${list}` : `TIP: ${tip}`;
}
async function tipOllaQuemada() {
  const tip = [
    'Olla quemada — cómo salvarla:',
    '1) Agua + bicarbonato (o vinagre) y hierve 5 min.',
    '2) Enfría y desprende con espátula.',
    '3) Usa pasta desengrasante y enjuaga.',
    '4) En acero inox, limpia con producto específico.'
  ].join('\n');
  const items = await searchMulti(['pink stuff pasta 850', 'astonish vitroceramica kit', 'weiman acero inoxidable 710'], 3);
  const list = buildProductsMarkdown(items);
  return list ? `TIP: ${tip}\n\n${list}` : `TIP: ${tip}`;
}
async function tipSillon() {
  const tip = [
    'Sillón/tapiz — rutina corta:',
    '1) Aspira bien.',
    '2) Prueba en zona oculta.',
    '3) Aplica limpiador de telas y retira con microfibra.',
    '4) Opción: protector textil anti manchas.'
  ].join('\n');
  const items = await searchMulti(['limpiador tela sofa', 'protector textil', 'quitamanchas tapiz'], 3);
  const list = buildProductsMarkdown(items);
  return list ? `TIP: ${tip}\n\n${list}` : `TIP: ${tip}`;
}
async function tipDetergenteCapsula(){
  const tip = [
    'Detergente en cápsula — uso seguro:',
    '1) 1 cápsula en el tambor (no en cajetín).',
    '2) Ropa encima. No cortes ni pinches la cápsula.',
    '3) Programa habitual.',
    '4) 2 cápsulas solo en cargas muy sucias o extra grandes.'
  ].join('\n');
  const items = await searchMulti(['detergente capsulas pods', 'pods detergente ropa'], 2);
  const list = buildProductsMarkdown(items);
  return list ? `TIP: ${tip}\n\n${list}` : `TIP: ${tip}`;
}
async function tipLamparas(){
  const tip = [
    'Lámparas — limpieza segura:',
    '1) Desenchufa y deja enfriar.',
    '2) Quita polvo con plumero o microfibra seca.',
    '3) Pantalla tela: aspira suave; espuma telas si hay manchas.',
    '4) Metal/vidrio: microfibra + limpiavidrios (sin mojar partes eléctricas).'
  ].join('\n');
  const items = await searchMulti(['limpia vidrios', 'microfibra', 'limpiador telas'], 2);
  const list = buildProductsMarkdown(items);
  return list ? `TIP: ${tip}\n\n${list}` : `TIP: ${tip}`;
}
async function tipManchaCarbonMuro(){
  const tip = [
    'Manchas de carbón/hollín en muro:',
    '1) Nada en seco. Usa esponja de melamina con pases suaves.',
    '2) Si queda sombra: multiuso diluido, prueba en zona oculta.',
    '3) En pintura mate: roce mínimo.',
    '4) Seca con paño limpio.'
  ].join('\n');
  const items = await searchMulti(['borrador magico', 'multiuso gatillo'], 2);
  const list = buildProductsMarkdown(items);
  return list ? `TIP: ${tip}\n\n${list}` : `TIP: ${tip}`;
}

/* =========================
   INTENT
   ========================= */
function detectIntent(text = '') {
  const qFold = fold((text || '').trim());
  const isComunaOnly = COMUNAS_FOLDED.has(qFold);
  const isRegionOnly = REGIONES_FOLDED.has(qFold);

  const infoTriggers = [
    'para que sirve','como usar','instrucciones','modo de uso','paso a paso',
    'ingredientes','composicion','sirve para','usos','beneficios','caracteristicas',
    'como puedo','como sacar','como limpiar','consejos','tips','que es',
    'envio','despacho','retiro','gratis','costo de envio','envio gratis',
    'mundopuntos','puntos','fidelizacion','checkout','cupon','codigo de descuento',
    'marcas venden','tipos de productos','que productos venden','que venden','marcas','categorias'
  ];
  const buyTriggers = ['comprar','agrega','agregar','añade','añadir','carrito','precio','recomiend','agregalo'];

  if (isComunaOnly || isRegionOnly) return 'info';
  if (infoTriggers.some(t => qFold.includes(t))) return 'info';
  if (buyTriggers.some(t => qFold.includes(t))) return 'buy';
  // Si contiene “para qué sirve / cómo…” lo forzamos a info
  if (PURPOSE_REGEX.test(text || '')) return 'info';
  return 'browse';
}

/* =========================
   ENDPOINT PRINCIPAL
   ========================= */
app.post('/chat', async (req, res) => {
  try {
    const { message, toolResult, meta = {} } = req.body;
    const userFirstName = (meta.userFirstName || '').trim();
    const FREE_TH = Number(FREE_SHIPPING_THRESHOLD_CLP ?? FREE_TH_DEFAULT);

    // Post-tool
    if (toolResult?.id) {
      const r = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Eres el asistente de MundoLimpio.cl. Responde breve, útil y con CTA cuando aplique.' },
          { role: 'user', content: `Resultado de tool cliente: ${JSON.stringify(toolResult)}` }
        ]
      });
      return res.json({ text: r.choices[0].message.content });
    }

    const intent = detectIntent(message || '');

    /* ===== Rama informativa / FAQs ===== */
    if (intent === 'info') {
      const faq = await faqAnswerOrNull(message || '', meta);
      if (faq) {
        const withTip = maybePrependGreetingTip(faq, meta, FREE_TH);
        return res.json({ text: withTip });
      }

      // Buscamos señales de producto específico
      const hardSearch = await shopifyStorefrontGraphQL(`
        query ProductSearch($q: String!) {
          search(query: $q, types: PRODUCT, first: 3) {
            edges { node { ... on Product { title handle availableForSale } } }
          }
        }
      `, { q: String(message || '').slice(0, 120) });

      const hits = (hardSearch?.search?.edges || []).map(e => e.node);

      // Caso 1: match claro o “para qué sirve…” → INFO de 1 producto + pasos
      if (hits.length >= 1 && PURPOSE_REGEX.test(message || '')) {
        const first = hits[0];
        const detail = await getProductDetailsByHandle(first.handle);
        const desc = stripAndTrim(detail?.description || '');
        const resumen = desc ? (desc.length > 320 ? desc.slice(0, 320) + '…' : desc)
                             : 'Limpia suciedad/manchas difíciles en superficies compatibles.';
        let text = [
          'Pasos rápidos:',
          '• Prueba en zona oculta.',
          '• Aplica según etiqueta y deja actuar.',
          '• Frota suave y enjuaga/retira.',
          '• Seca bien y repite si es necesario.'
        ].join('\n');
        text += `\n\nINFO: ${(detail?.title || first.title || 'Producto').trim()}\n${resumen}\nURL: ${BASE}/products/${first.handle}`;
        return res.json({ text: maybePrependGreetingTip(text, meta, FREE_TH) });
      }

      // Caso 2: varios matches informativos → explicación + máx 2 productos
      if (hits.length > 1) {
        const two = await preferInStock(hits.slice(0, 4), 2);
        const list = buildProductsMarkdown(two);
        let text = [
          'Te cuento rápido:',
          '• Sirve para remover suciedad/manchas en superficies compatibles.',
          '• Aplica, deja actuar y retira según la etiqueta.',
          '• Usa guantes y ventila si corresponde.'
        ].join('\n');
        text = list ? `${text}\n\n${list}` : text;
        return res.json({ text: maybePrependGreetingTip(text, meta, FREE_TH) });
      }

      // Consejos por IA (productos opcionales y cap)
      const ai = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: AI_RESPONSE_POLICY },
          { role: 'system', content: 'Cuando muestres productos, máx 2–3 y solo si suman valor. Si no ayudan, no muestres.' },
          { role: 'system', content: userFirstName ? `Nombre del usuario: ${userFirstName}` : '' },
          { role: 'user', content: message || '' }
        ].filter(m => m.content)
      });

      let aiText = (ai.choices?.[0]?.message?.content || '').trim();
      if (!aiText) aiText = 'Pasos clave:\n• Prueba en zona oculta.\n• Aplica según etiqueta.\n• Retira y seca.';

      const productCap = PURPOSE_REGEX.test(message || '') ? 2 : 3;

      let picks = await titleMatchProducts(message, productCap);
      if (picks.length < productCap) {
        const kws = extractKeywords(message, 6);
        if (kws.length) {
          const more = await searchMulti(kws, productCap - picks.length);
          const seen = new Set(picks.map(p=>p.handle));
          for (const m of more) if (!seen.has(m.handle)) picks.push(m);
        }
      }
      picks = picks.slice(0, productCap);

      let textOut = aiText;
      if (picks.length) {
        const list = buildProductsMarkdown(picks);
        if (list) textOut += `\n\n${list}`;
      }
      return res.json({ text: maybePrependGreetingTip(textOut, meta, FREE_TH) });
    }

    /* ===== Ganchos previos (browse/buy) sin IA ===== */
    const orderedKeywordPicks = await selectProductsByOrderedKeywords(message, 1);
    if (orderedKeywordPicks && orderedKeywordPicks.length) {
      let text = `Te dejo una opción por lo que pediste:\n\n${buildProductsMarkdown(orderedKeywordPicks)}`;
      return res.json({ text: maybePrependGreetingTip(text, meta, FREE_TH) });
    }

    const qn = norm(message || '');
    if (/(mas vendidos|más vendidos|best sellers|top ventas|lo mas vendido|lo más vendido)/.test(qn)) {
      const items = await listTopSellers(5).then(xs => preferInStock(xs, 5));
      let text = buildProductsMarkdown(items) || "Por ahora no tengo un ranking de más vendidos.";
      return res.json({ text: maybePrependGreetingTip(text, meta, FREE_TH) });
    }

    const brandAsk = message || '';
    const mBrand = brandAsk.toLowerCase().match(/tienen la marca\s+([a-z0-9&\-\s]+)/i) || brandAsk.toLowerCase().match(/tienen\s+([a-z0-9&\-\s]+)\??$/i);
    if (mBrand) {
      const brand = mBrand[1].trim();
      if (brand.length >= 2 && brand.length <= 40) {
        let items = await searchByVendor(brand, 12);
        if (items.length < 6) {
          const more = await searchProductsPlain(brand, 20);
          const seen = new Set(items.map(i => i.handle));
          for (const it of more) if (!seen.has(it.handle)) { items.push(it); seen.add(it.handle); }
        }
        if (items.length) {
          const picks = await preferInStock(items, Math.min(items.length, 10));
          let text = buildProductsMarkdown(picks);
          return res.json({ text: maybePrependGreetingTip(text, meta, FREE_TH) });
        }
        return res.json({ text: `Sí trabajamos varias marcas. No encontré resultados exactos para "${brand}". ¿Quieres alternativas similares?` });
      }
    }

    if (/pasta.*(rosada|pink)|pink.*stuff/i.test(qn)) {
      const items = await searchProductsPlain('pink stuff pasta multiuso stardrops', 5).then(xs => preferInStock(xs, 5));
      if (items.length) return res.json({ text: maybePrependGreetingTip(buildProductsMarkdown(items), meta, FREE_TH) });
    }
    if (/pasta.*(original|astonish)|astonish.*pasta/i.test(qn)) {
      const items = await searchProductsPlain('astonish pasta original multiuso', 5).then(xs => preferInStock(xs, 5));
      if (items.length) return res.json({ text: maybePrependGreetingTip(buildProductsMarkdown(items), meta, FREE_TH) });
    }
    if (/ecolog|eco|biodegrad/i.test(qn)) {
      const items = await searchProductsPlain('ecologico biodegradable eco plant-based', 5).then(xs => preferInStock(xs, 5));
      if (items.length) return res.json({ text: maybePrependGreetingTip(buildProductsMarkdown(items), meta, FREE_TH) });
    }

    const wantsBano   = /ba[nñ]o/.test(qn);
    const wantsCocina = /cocina/.test(qn);
    const wantsHorno  = /horno/.test(qn);
    if (wantsBano || wantsCocina || wantsHorno) {
      const zones = [];
      if (wantsBano) zones.push('baño');
      if (wantsCocina) zones.push('cocina');
      if (wantsHorno) zones.push('horno');

      const wantedPerZone = zones.length === 1 ? 4 : 2;
      const maxTotal = zones.length === 1 ? 6 : Math.max(4, zones.length * 2);

      const items = await (async () => {
        const seeds = {
          'baño':   ['antihongos baño','moho ducha','limpia sarro'],
          'cocina': ['desengrasante cocina','weiman cook top','goo gone'],
          'horno':  ['astonish horno','goo gone bbq','desengrasante horno']
        };
        const pool = [];
        const seen = new Set();
        for (const z of zones) {
          for (const q of (seeds[z] || [])) {
            const found = await searchProductsPlain(q, 6);
            for (const it of found) {
              if (!seen.has(it.handle)) { seen.add(it.handle); pool.push(it); }
            }
          }
        }
        return preferInStock(pool, Math.min(maxTotal, zones.length * wantedPerZone));
      })();

      if (items.length) {
        const header = zones.length === 1
          ? `Te dejo opciones para **${zones[0]}**:`
          : `Sugerencias por zona (${zones.join(', ')}):`;
        let text = `${header}\n\n${buildProductsMarkdown(items)}`;
        return res.json({ text: maybePrependGreetingTip(text, meta, FREE_TH) });
      }
    }

    /* ===== Rama browse/buy con IA (tools) ===== */
    const tools = [
      {
        type: 'function',
        function: {
          name: 'searchProducts',
          description: 'Busca productos por texto y devuelve hasta 5 resultados con URL real y variantes.',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'getVariantByOptions',
          description: 'Dado un handle y opciones, devuelve variantId NUMÉRICO para /cart/add.js.',
          parameters: {
            type: 'object',
            properties: {
              handle: { type: 'string' },
              options: { type: 'object', additionalProperties: { type: 'string' } }
            },
            required: ['handle']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'addToCartClient',
          description: 'Pedir al navegador ejecutar /cart/add.js con {variantId, quantity}.',
          parameters: {
            type: 'object',
            properties: { variantId: { type: 'string' }, quantity: { type: 'number', default: 1 } },
            required: ['variantId']
          }
        }
      }
    ];

    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      tools,
      tool_choice: 'auto',
      messages: [
        {
          role: 'system',
          content: [
            "Eres el asistente de MundoLimpio.cl.",
            "NUNCA inventes productos, precios ni enlaces.",
            "Para recomendar productos usa la función searchProducts y sus resultados.",
            "Cuando muestres productos, incluye el enlace REAL a /products/{handle}.",
            "Para agregar al carrito: getVariantByOptions -> addToCartClient.",
            "Español Chile, tono claro y con CTA."
          ].join(' ')
        },
        { role: 'user', content: message || '' }
      ]
    });

    const msg = r.choices[0].message;

    if (msg.tool_calls?.length) {
      for (const c of msg.tool_calls) {
        const args = JSON.parse(c.function.arguments || '{}');

        if (c.function.name === 'searchProducts') {
          const data = await shopifyStorefrontGraphQL(`
            query ProductSearch($q: String!) {
              search(query: $q, types: PRODUCT, first: 5) {
                edges { node { ... on Product { title handle availableForSale } } }
              }
            }
          `, { q: args.query });
          const items = (data.search?.edges || []).map(e => ({ title: e.node.title, handle: e.node.handle }));
          let text = buildProductsMarkdown(items);
          if (text) return res.json({ text: maybePrependGreetingTip(text, meta, FREE_TH) });
        }

        if (c.function.name === 'getVariantByOptions') {
          const { handle, options = {} } = args;
          const p = await getProductJsonByHandle(handle);
          const vals = Object.values(options).map(v => String(v).toLowerCase().trim()).filter(Boolean);
          let match = null;
          for (const v of p.variants) {
            const pack = [v.title, v.option1, v.option2, v.option3].filter(Boolean).map(s => String(s).toLowerCase().trim());
            const ok = vals.every(val => pack.some(piece => piece.includes(val)));
            if (ok) { match = v; break; }
          }
          if (!match) match = p.variants.find(v => v.available) || p.variants[0];
          if (!match) throw new Error('Sin variantes para ' + handle);
          return res.json({
            toolCalls: [{ id: c.id, name: 'addToCartClient', arguments: { variantId: String(match.id), quantity: 1 } }]
          });
        }
      }
    }

    // Antes del fallback simple: prioriza coincidencia por TÍTULO + STOCK
    const direct = await titleMatchProducts(message, 5);
    if (direct.length) {
      let text = buildProductsMarkdown(direct);
      return res.json({ text: maybePrependGreetingTip(text, meta, FREE_TH) });
    }

    // Fallback: búsqueda directa simple
    try {
      const forced = await shopifyStorefrontGraphQL(`
        query ProductSearch($q: String!) {
          search(query: $q, types: PRODUCT, first: 5) {
            edges { node { ... on Product { title handle } } }
          }
        }
      `, { q: String(message || '').slice(0, 120) });
      const items = (forced.search?.edges || []).map(e => ({ title: e.node.title, handle: e.node.handle }));
      if (items.length) {
        let text = buildProductsMarkdown(items);
        return res.json({ text: maybePrependGreetingTip(text, meta, FREE_TH) });
      }
    } catch (err) { console.warn('Fallback searchProducts failed:', err?.message || err); }

    // Fallback final
    return res.json({
      text: userFirstName
        ? `Gracias, ${userFirstName}. ¿Me das una pista más (marca, superficie, aroma)? También puedo sugerir opciones similares.`
        : "No encontré resultados exactos. ¿Me das una pista más (marca, superficie, aroma)? También puedo sugerir opciones similares."
    });

  } catch (e) {
    console.error(e);
    if (e?.code === 'insufficient_quota' || e?.status === 429) {
      return res.json({ text: "Estoy con alto tráfico. Dime qué producto buscas y te paso el enlace para agregarlo al carrito." });
    }
    return res.status(500).json({ error: String(e) });
  }
});

/* =========================
   FAQ / GUÍAS (async)
   ========================= */
async function faqAnswerOrNull(message = '', meta = {}) {
  const raw = (message || '').trim();

  // Prefijo “envío …”
  const mPref = raw.match(/^(env[ií]o|envio|despacho|retiro)\s+(.+)$/i);
  const locationOnly = mPref ? mPref[2] : raw;
  const qFold = fold(locationOnly);

  const FREE_TH = Number(FREE_SHIPPING_THRESHOLD_CLP ?? FREE_TH_DEFAULT);
  const destinosUrl = `${BASE}/pages/destinos-disponibles-en-chile`;

  // Región sola
  if (REGIONES_FOLDED.has(qFold)) {
    const regNice = REGIONES.find(r => fold(r) === qFold) || locationOnly;
    const ship = shippingByRegionName(regNice);
    const isRM = /metropolitana|santiago/.test(qFold);
    let parts = [];
    if (ship) {
      parts.push(`Para **${titleCaseComuna(regNice)}** (${ship.zone}), el costo referencial es **${formatCLP(ship.cost)}**.`);
    } else {
      parts.push(`Para **${titleCaseComuna(regNice)}**, el costo se calcula en el checkout según **región/comuna** y peso.`);
    }
    if (isRM && FREE_TH > 0) {
      parts.push(`En **RM** ofrecemos **envío gratis** sobre **${formatCLP(FREE_TH)}** (bajo ese monto: ${formatCLP(3990)}).`);
    }
    parts.push(`📦 Frecuencias por zona: ${destinosUrl}`);
    return parts.join(' ');
  }

  // Comuna sola
  if (COMUNAS_FOLDED.has(qFold)) {
    const idx = COMUNAS.findIndex(c => fold(c) === qFold);
    const comunaNice = idx >= 0 ? titleCaseComuna(COMUNAS[idx]) : titleCaseComuna(locationOnly);
    return `Hacemos despacho a **todo Chile**. Para **${comunaNice}**, el costo se calcula automáticamente en el checkout al ingresar **región y comuna**. Si me confirmas la **región**, puedo darte el costo referencial. 📦 Frecuencias: ${destinosUrl}`;
  }

  // ENVÍOS genérico
  if (/(env[ií]o|envio|despacho|retiro)/i.test(raw)) {
    const header = FREE_TH > 0
      ? `En la **Región Metropolitana (RM)** ofrecemos **envío gratis** en compras sobre **${formatCLP(FREE_TH)}**.`
      : `Hacemos despacho a **todo Chile**.`;
    const para2 = `Para pedidos bajo ese monto en la RM, y para **todas las regiones**, el costo de envío se calcula automáticamente en el **checkout** según la **región y comuna** de destino.`;
    const para3 = `Si me indicas tu **región** y **comuna**, puedo confirmarte el **costo** y la **frecuencia de entrega** en tu zona.`;
    const para4 = `📦 Frecuencias de entrega: ${destinosUrl}`;
    const tarifas =
      `Tarifas referenciales por región:\n` +
      `- **RM**: ${formatCLP(3990)}\n` +
      `- **Zona Central**: ${formatCLP(6990)}\n` +
      `- **Zona Norte**: ${formatCLP(10990)}\n` +
      `- **Zona Austral**: ${formatCLP(14990)}`;
    return [header, '', para2, '', para3, para4, '', tarifas].join('\n');
  }

  // Campo de cupón en checkout
  if (/(donde|en que parte|cómo|como).*(checkout|pago|carro|carrito).*(cupon|cup[oó]n|c[oó]digo de descuento|codigo de descuento)/i.test(raw)) {
    return [
      `En el **checkout** (primera pantalla) verás el campo **“Código de descuento o tarjeta de regalo”**.`,
      `Pega tu cupón y presiona **Aplicar**.`,
      `Si es un cupón de **Mundopuntos**, primero géneralo en el **widget de recompensas** y luego cópialo en ese campo.`
    ].join(' ');
  }

  // ¿Qué es Mundo Limpio? / categorías
  if (/(que es|qué es|quienes son|quiénes son).*(mundolimpio|mundo limpio)|que venden en mundolimpio|que productos venden\??$/i.test(raw)) {
    const cols = await listCollections(8);
    if (!cols.length) return `**MundoLimpio.cl** es una tienda chilena de limpieza/hogar premium.`;
    const payload = cols.map(c => `${c.title}|${BASE}/collections/${c.handle}`).join('\n');
    return `CATS:\n${payload}`;
  }

  // ¿Qué marcas venden? → carrusel (prioriza BRAND_CAROUSEL_JSON)
  if (/(que|qué)\s+marcas.*venden|marcas\s*(disponibles|que tienen|venden)/i.test(raw)) {
    const custom = parseBrandCarouselConfig();
    if (custom.length) {
      const payload = buildBrandsPayload(custom);
      if (payload) return payload;
    }
    const vendors = await listVendors(20);
    if (!vendors.length) return 'Trabajamos varias marcas internacionales y locales. ¿Cuál te interesa?';
    const brands = vendors.map(v => ({
      title: v,
      url: `${BASE}/collections/vendors?q=${encodeURIComponent(v)}`,
      image: ''
    }));
    const payload = buildBrandsPayload(brands);
    return payload || `Trabajamos marcas como: **${vendors.join('**, **')}**. ¿Buscas alguna en particular?`;
  }

  // ¿Qué TIPOS de productos venden? → categorías
  if (/(que|qué)\s+tipos\s+de\s+productos\s+venden|categor[ií]as|secciones|colecciones/i.test(raw)) {
    const cols = await listCollections(10);
    if (!cols.length) return 'Tenemos múltiples categorías: cocina, baño, pisos, lavandería, superficies, accesorios y más.';
    const payload = cols.map(c => `${c.title}|${BASE}/collections/${c.handle}`).join('\n');
    return `CATS:\n${payload}`;
  }

  // Atajos TIP
  if (/vitrocer[aá]mica|vitro\s*cer[aá]mica/i.test(raw)) return await tipVitro();
  if (/alfombra(s)?/i.test(raw)) return await tipAlfombra();
  if (/cortina(s)?/i.test(raw)) return await tipCortina();
  if (/olla.*quemad/i.test(raw)) return await tipOllaQuemada();
  if (/sill[oó]n|sofa|sof[aá]|tapiz/i.test(raw)) return await tipSillon();

  if (/capsul(a|as).*(detergente)|detergente.*capsul(a|as)/i.test(raw)) return await tipDetergenteCapsula();
  if (/lampara(s)?/i.test(raw)) return await tipLamparas();
  if (/(carbon|holl[ií]n).*(muro|pared|muralla)/i.test(raw)) return await tipManchaCarbonMuro();

  // MUNDOPUNTOS
  if (/mundopuntos|puntos|fidelizaci[óo]n/i.test(raw)) {
    const earn = Number(MUNDOPUNTOS_EARN_PER_CLP || 1);
    const redeem100 = Number(MUNDOPUNTOS_REDEEM_PER_100 || 3);
    const url = (MUNDOPUNTOS_PAGE_URL || '').trim();

    const parts = [
      `**Mundopuntos**: ganas **${earn} punto(s) por cada $1** que gastes.`,
      `El canje es **100 puntos = ${formatCLP(redeem100)}**.`,
      `Puedes canjear en el **checkout** ingresando tu cupón.`
    ];
    if (url) parts.push(`Más info: ${url}`);
    else     parts.push(`También puedes ver y canjear en el **widget de recompensas** en la tienda.`);
    return parts.join(' ');
  }

  // HONGOS/moho genérico breve
  if (/(hongo|moho).*(baño|ducha|tina)|sacar los hongos|sacar hongos/i.test(raw)) {
    const items = await searchMulti(['antihongos baño', 'antihongos interior', 'moho ducha'], 3).then(xs => preferInStock(xs, 3));
    const tip = [
      'Baño con hongos — rápido:',
      '1) Ventila y usa guantes.',
      '2) Aplica antihongos 5–10 min.',
      '3) Cepilla, enjuaga y seca bien.'
    ].join('\n');
    const list = buildProductsMarkdown(items);
    return list ? `TIP: ${tip}\n\n${list}` : `TIP: ${tip}`;
  }

  return null;
}

/* =========================
   HEALTHCHECK
   ========================= */
app.get('/health', (_, res) => res.json({ ok: true }));

const port = PORT || process.env.PORT || 3000;
app.listen(port, () => console.log('ML Chat server on :' + port));

