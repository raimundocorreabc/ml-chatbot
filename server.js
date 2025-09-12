// server.js
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

  // Config FAQs
  FREE_SHIPPING_THRESHOLD_CLP, // default 40000 (RM)
  MUNDOPUNTOS_EARN_PER_CLP,
  MUNDOPUNTOS_REDEEM_PER_100,
  MUNDOPUNTOS_PAGE_URL
} = process.env;

if (!OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY");
if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_STOREFRONT_TOKEN) throw new Error("Falta SHOPIFY_STORE_DOMAIN o SHOPIFY_STOREFRONT_TOKEN");
if (!SHOPIFY_PUBLIC_STORE_DOMAIN) throw new Error("Falta SHOPIFY_PUBLIC_STORE_DOMAIN");

const allowed = (ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

const app = express();
app.use(express.json());

// CORS con logging de diagnóstico
app.use(cors({
  origin: (origin, cb) => {
    const ok = (!origin || allowed.includes(origin));
    if (!ok) console.warn('CORS bloqueado para:', origin, ' | permitidos:', allowed);
    return ok ? cb(null, true) : cb(new Error('Origen no permitido'));
  },
  credentials: true
}));

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ---------------- Utils generales ---------------- */
const BASE = (SHOPIFY_PUBLIC_STORE_DOMAIN || '').replace(/\/$/, '');
const FREE_TH_DEFAULT = 40000; // RM sobre $40.000

function formatCLP(n) {
  const v = Math.round(Number(n) || 0);
  return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(v);
}
function titleCaseComuna(s) { return String(s||'').toLowerCase().replace(/\b\w/g, m => m.toUpperCase()); }

// Normalización
function norm(s=''){ return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }
function fold(s=''){ return norm(s).replace(/ñ/g,'n'); }

/* ---------------- Regiones y comunas ---------------- */
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

/* ---------------- Shopify utils ---------------- */
async function shopifyStorefrontGraphQL(query, variables = {}) {
  const url = `https://${SHOPIFY_STORE_DOMAIN}/api/2025-07/graphql.json`;
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
  const r = await fetch(url);
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
      }
    }
  `, { h: handle });
  return data.product || null;
}

/* ---------------- Búsquedas directas (antes de IA) ---------------- */
async function searchProductsPlain(query, first = 5) {
  const data = await shopifyStorefrontGraphQL(`
    query SearchProducts($q: String!, $n: Int!) {
      search(query: $q, types: PRODUCT, first: $n) {
        edges { node { ... on Product { title handle } } }
      }
    }
  `, { q: query, n: first });
  return (data.search?.edges || []).map(e => ({ title: e.node.title, handle: e.node.handle }));
}

async function listTopSellers(first = 5) {
  const data = await shopifyStorefrontGraphQL(`
    query TopSellers($n: Int!) {
      products(first: $n, sortKey: BEST_SELLING) {
        edges { node { title handle } }
      }
    }
  `, { n: first });
  return (data.products?.edges || []).map(e => ({ title: e.node.title, handle: e.node.handle }));
}

async function searchByVendor(vendor, first = 5) {
  const data = await shopifyStorefrontGraphQL(`
    query ByVendor($q: String!, $n: Int!) {
      products(first: $n, query: $q) {
        edges { node { title handle vendor } }
      }
    }
  `, { q: `vendor:"${vendor}"`, n: first });
  return (data.products?.edges || []).map(e => ({ title: e.node.title, handle: e.node.handle }));
}

// Multi-búsqueda incremental hasta completar max ítems
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

/* ---------------- Tools de IA ---------------- */
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

/* ---------------- Helpers texto/productos ---------------- */
function buildProductsMarkdown(items = []) {
  if (!items.length) return null;
  const lines = items.map((p, i) => {
    const safeTitle = (p.title || 'Ver producto').replace(/\*/g, '');
    return `${i + 1}. **[${safeTitle}](${BASE}/products/${p.handle})** – agrega al carrito o ver más detalles.`;
  });
  return `Aquí tienes opciones:\n\n${lines.join('\n')}`;
}

function stripAndTrim(s = '') {
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// TIP de saludo + progreso a envío gratis (solo una vez y con carrito > 0)
function maybePrependGreetingTip(text, meta, FREE_TH) {
  const name = (meta?.userFirstName || '').trim();
  const already = !!meta?.tipAlreadyShown;
  if (!name || already) return text;

  const sub = Number(meta?.cartSubtotalCLP || 0);
  const hasCart = Number.isFinite(sub) && sub > 0;
  const showProgress = hasCart && FREE_TH > 0 && sub < FREE_TH;

  const extra = showProgress ? ` | Te faltan ${formatCLP(FREE_TH - sub)} para envío gratis en RM` : '';
  return `TIP: Hola, ${name} 👋${extra}\n\n${text}`;
}

/* ==================== Helpers de TIPs temáticos ==================== */

// LISTAR MARCAS (vendors)
async function listVendors(limit = 20) {
  const data = await shopifyStorefrontGraphQL(`
    query Vendors {
      products(first: 100) {
        edges { node { vendor } }
      }
    }
  `);
  const vendors = (data.products?.edges || [])
    .map(e => (e.node.vendor || '').trim())
    .filter(Boolean);

  const freq = new Map();
  for (const v of vendors) freq.set(v, (freq.get(v) || 0) + 1);
  const sorted = [...freq.entries()].sort((a,b) => b[1]-a[1]).map(([v]) => v);

  return sorted.slice(0, limit);
}

// LISTAR COLECCIONES (filtradas)
async function listCollections(limit = 10) {
  const data = await shopifyStorefrontGraphQL(`
    query Colls($n:Int!) {
      collections(first: $n) { edges { node { title handle } } }
    }
  `, { n: limit + 5 });
  const all = (data.collections?.edges || []).map(e => ({
    title: e.node.title, handle: e.node.handle
  }));
  // filtra algunas no útiles
  const skip = new Set(['frontpage','all','sale','ofertas','destacados']);
  return all.filter(c => !skip.has(String(c.handle).toLowerCase())).slice(0, limit);
}

// RECOMENDAR 1 PRODUCTO POR ZONA
async function recommendZoneProducts(zones = []) {
  const queries = {
    'baño':   ['astonish baño 750', 'baño limpiador astonish', 'baño desinfección'],
    'cocina': ['degreaser cocina', 'astonish kitchen', 'cif crema'],
    'horno':  ['astonish horno parrilla', 'goo gone bbq horno'],
  };

  const picks = [];
  for (const z of zones) {
    const qs = queries[z] || [];
    let found = null;
    for (const q of qs) {
      const items = await searchProductsPlain(q, 1);
      if (items.length) { found = items[0]; break; }
    }
    if (found) picks.push(found);
  }
  return picks;
}

// TIPS concisos + productos
async function tipVitro() {
  const tip = [
    'Vitrocerámica — pasos rápidos:',
    '1) Con la placa fría, retira residuos con rasqueta plástica.',
    '2) Aplica crema específica, deja actuar 1–2 min.',
    '3) Pasa paño microfibra; repite en manchas quemadas.',
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
    '2) Trata manchas puntuales con quitamanchas de telas.',
    '3) Lava según etiqueta (ciclo delicado) o limpieza en seco.',
    '4) Protege con spray textil anti manchas si es habitual.'
  ].join('\n');
  const items = await searchMulti(['quitamanchas tela', 'protector textil', 'limpiador telas'], 3);
  const list = buildProductsMarkdown(items);
  return list ? `TIP: ${tip}\n\n${list}` : `TIP: ${tip}`;
}

async function tipOllaQuemada() {
  const tip = [
    'Olla quemada — cómo salvarla:',
    '1) Cubre fondo con agua + bicarbonato (o vinagre).',
    '2) Hierve 5 min y enfría; desprende con espátula.',
    '3) Usa pasta desengrasante y enjuaga.',
    '4) En acero inox, termina con limpiador específico.'
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

/* ---------------- Intent ---------------- */
function detectIntent(text = '') {
  const qFold = fold((text || '').trim());
  const isComunaOnly = COMUNAS_FOLDED.has(qFold);
  const isRegionOnly = REGIONES_FOLDED.has(qFold);

  const infoTriggers = [
    'para que sirve','como usar','instrucciones','modo de uso','ingredientes','composicion',
    'sirve para','usos','beneficios','caracteristicas','como puedo','como sacar','como limpiar',
    'consejos','tips','que es','envio','despacho','retiro','gratis','costo de envio','envio gratis',
    'mundopuntos','puntos','fidelizacion','checkout','cupon','codigo de descuento',
    'marcas venden','tipos de productos','que productos venden','que venden'
  ];
  const buyTriggers = ['comprar','agrega','agregar','añade','añadir','carrito','precio','recomiend'];

  if (isComunaOnly || isRegionOnly) return 'info';
  if (infoTriggers.some(t => qFold.includes(t))) return 'info';
  if (buyTriggers.some(t => qFold.includes(t))) return 'buy';
  return 'browse';
}

/* ==================== FAQ/guías (async) ==================== */
async function faqAnswerOrNull(message = '', meta = {}) {
  const raw = (message || '').trim();
  const q = norm(raw);

  const FREE_TH = Number(FREE_SHIPPING_THRESHOLD_CLP ?? FREE_TH_DEFAULT);
  const freeStrRM = FREE_TH > 0 ? `**envío gratis** desde **${formatCLP(FREE_TH)}**` : null;
  const destinosUrl = `${BASE}/pages/destinos-disponibles-en-chile`;

  // Región sola
  if (REGIONES_FOLDED.has(q)) {
    const isRM = /metropolitana|santiago/.test(q);
    const rmExtra = isRM && freeStrRM ? ` En RM, ${freeStrRM}.` : '';
    let line = `Hacemos despacho a **todo Chile**.${rmExtra} Para regiones, el costo se calcula en el checkout según **región y comuna** y peso. Frecuencias por zona: ${destinosUrl}`;
    const sub = Number(meta?.cartSubtotalCLP || 0);
    if (isRM && sub > 0 && FREE_TH > 0 && sub < FREE_TH) {
      line = `TIP: Te faltan **${formatCLP(FREE_TH - sub)}** para envío gratis en RM.\n\n${line}`;
    }
    return line;
  }

  // Comuna sola
  if (COMUNAS_FOLDED.has(q)) {
    const idx = COMUNAS.findIndex(c => fold(c) === q);
    const comunaNice = idx >= 0 ? titleCaseComuna(COMUNAS[idx]) : titleCaseComuna(raw);
    const rmHint = freeStrRM ? ` En RM, ${freeStrRM}.` : '';
    let line = `Hacemos despacho a **todo Chile**.${rmHint} Para **${comunaNice}**, el costo se calcula en el checkout al ingresar **región y comuna**. Frecuencias por zona: ${destinosUrl}`;
    const sub = Number(meta?.cartSubtotalCLP || 0);
    if (sub > 0 && FREE_TH > 0 && sub < FREE_TH) {
      line = `TIP: Te faltan **${formatCLP(FREE_TH - sub)}** para envío gratis en RM.\n\n${line}`;
    }
    return line;
  }

  // ENVÍOS genérico
  if (/(env[ií]o|envio|despacho|retiro)/i.test(raw)) {
    const base = `Hacemos despacho a **todo Chile**.`;
    const sub = Number(meta?.cartSubtotalCLP || 0);
    const progress = (sub > 0 && FREE_TH > 0 && sub < FREE_TH)
      ? `TIP: Te faltan **${formatCLP(FREE_TH - sub)}** para envío gratis en RM.\n\n` : '';
    if (/gratis|m[ií]nimo|minimo|sobre cu[aá]nto/i.test(raw)) {
      if (freeStrRM) return `${progress}${base} En **RM** ofrecemos ${freeStrRM}. Bajo ese monto, y para **regiones**, el costo se calcula en checkout según **región/comuna** y peso. ¿Para qué **región y comuna** lo necesitas? Frecuencias: ${destinosUrl}`;
      return `${progress}${base} El costo se calcula en checkout según **región/comuna** y peso. ¿Para qué **región y comuna** lo necesitas? Frecuencias: ${destinosUrl}`;
    }
    return `${progress}${base} El costo y tiempos dependen de **región/comuna** y peso. En el checkout verás las opciones disponibles. ¿Para qué **región y comuna**? Frecuencias: ${destinosUrl}`;
  }

  // ¿Dónde canjear cupón en checkout?
  if (/(donde|en que parte|cómo|como).*(checkout|pago|carro|carrito).*(cupon|cup[oó]n|c[oó]digo de descuento|codigo de descuento)/i.test(raw)) {
    return [
      `En el **checkout** (primera pantalla) verás el campo **“Código de descuento o tarjeta de regalo”**.`,
      `Pega tu cupón y presiona **Aplicar**.`,
      `Si es un cupón de **Mundopuntos**, primero géneralo en el **widget de recompensas** y luego cópialo en ese campo.`
    ].join(' ');
  }

  // ¿Qué es Mundo Limpio? / ¿Qué venden?
  if (/(que es|qué es|quienes son|quiénes son).*(mundolimpio|mundo limpio)|que venden en mundolimpio|que productos venden\??$/i.test(raw)) {
    const cols = await listCollections(8);
    if (!cols.length) return `**MundoLimpio.cl** es una tienda chilena de limpieza/hogar premium.`;
    // devolvemos para el front como botones
    const payload = cols.map(c => `${c.title}|${BASE}/collections/${c.handle}`).join('\n');
    return `CATS:\n${payload}`;
  }

  // ¿Qué MARCAS venden?
  if (/(que|qué)\s+marcas.*venden|marcas\s*(disponibles|que tienen|venden)/i.test(raw)) {
    const vendors = await listVendors(20);
    if (!vendors.length) return 'Trabajamos varias marcas internacionales y locales. ¿Cuál te interesa?';
    return `Trabajamos marcas como: **${vendors.join('**, **')}**. ¿Buscas alguna en particular?`;
  }

  // ¿Qué TIPOS de productos venden? → categorías como botones
  if (/(que|qué)\s+tipos\s+de\s+productos\s+venden|categor[ií]as|secciones|colecciones/i.test(raw)) {
    const cols = await listCollections(10);
    if (!cols.length) return 'Tenemos múltiples categorías: cocina, baño, pisos, lavandería, superficies, accesorios y más.';
    const payload = cols.map(c => `${c.title}|${BASE}/collections/${c.handle}`).join('\n');
    return `CATS:\n${payload}`;
  }

  // Temas específicos con TIP conciso + productos
  if (/vitrocer[aá]mica|vitro\s*cer[aá]mica/i.test(raw)) return await tipVitro();
  if (/alfombra(s)?/i.test(raw)) return await tipAlfombra();
  if (/cortina(s)?/i.test(raw)) return await tipCortina();
  if (/olla.*quemad/i.test(q)) return await tipOllaQuemada();
  if (/sill[oó]n|sofa|sof[aá]|tapiz/i.test(q)) return await tipSillon();

  // MUNDOPUNTOS (sin link si no hay página)
  if (/mundopuntos|puntos|fidelizaci[óo]n/i.test(raw)) {
    const earn = Number(MUNDOPUNTOS_EARN_PER_CLP || 1);
    const redeem100 = Number(MUNDOPUNTOS_REDEEM_PER_100 || 3);
    const url = (MUNDOPUNTOS_PAGE_URL || '').trim();

    const parts = [
      `**Mundopuntos**: ganas **${earn} punto(s) por cada $1** que gastes.`,
      `El canje es **100 puntos = ${formatCLP(redeem100)}** (≈ ${(redeem100/100*100).toFixed(0)}% de retorno).`,
      `Puedes canjear en el **checkout** ingresando tu cupón.`
    ];
    if (url) parts.push(`Más info: ${url}`);
    else     parts.push(`También puedes ver y canjear tus puntos en el **widget de recompensas** en la tienda.`);
    return parts.join(' ');
  }

  // HONGOS / MOHO (genérico breve)
  if (/(hongo|moho).*(baño|ducha|tina)|sacar los hongos|sacar hongos/i.test(raw)) {
    const items = await searchMulti(['antihongos baño', 'antihongos interior', 'moho ducha'], 3);
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

/* --------- Hooks de intención de compra (antes de IA) --------- */
function synonymQueryOrNull(message='') {
  const q = norm(message);
  if (/pasta.*(rosada|pink)|pink.*stuff/.test(q)) return 'pink stuff pasta multiuso stardrops';
  if (/pasta.*(original|astonish)|astonish.*pasta/.test(q)) return 'astonish pasta original multiuso';
  if (/ecolog|eco|biodegrad/i.test(q)) return 'ecologico biodegradable eco plant-based';
  return null;
}

function extractBrandOrNull(message='') {
  const q = message.toLowerCase();
  const m = q.match(/tienen la marca\s+([a-z0-9&\-\s]+)/i) || q.match(/tienen\s+([a-z0-9&\-\s]+)\??$/i);
  if (!m) return null;
  const brand = m[1].trim();
  if (brand.length < 2 || brand.length > 40) return null;
  return brand;
}

function isAskBestSellers(message='') {
  const q = norm(message);
  return /(mas vendidos|más vendidos|best sellers|top ventas|lo mas vendido|lo más vendido)/.test(q);
}

/* ---------------- Endpoint principal ---------------- */
app.post('/chat', async (req, res) => {
  try {
    const { message, toolResult, meta = {} } = req.body;
    const userFirstName = (meta.userFirstName || '').trim();
    const FREE_TH = Number(FREE_SHIPPING_THRESHOLD_CLP ?? FREE_TH_DEFAULT);

    // Post-tool (después de agregar al carrito)
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

    /* ===== Rama informativa / FAQs sin tarjetas ===== */
    if (intent === 'info') {
      // 1) Intentar FAQ directa (incluye TIPS + productos cuando aplica)
      const faq = await faqAnswerOrNull(message || '', meta);
      if (faq) {
        const withTip = maybePrependGreetingTip(faq, meta, FREE_TH);
        return res.json({ text: withTip });
      }

      // 2) Si no es FAQ, intentar extraer info de un producto relacionado
      const forced = await shopifyStorefrontGraphQL(`
        query ProductSearch($q: String!) {
          search(query: $q, types: PRODUCT, first: 1) {
            edges { node { ... on Product { title handle } } }
          }
        }
      `, { q: String(message || '').slice(0, 120) });

      const node = forced?.search?.edges?.[0]?.node;
      if (node?.handle) {
        const detail = await getProductDetailsByHandle(node.handle);
        const desc = stripAndTrim(detail?.description || '');
        const resumen = desc
          ? (desc.length > 300 ? desc.slice(0, 300) + '…' : desc)
          : 'Es un limpiador multiusos diseñado para remover suciedad difícil de superficies compatibles.';
        const url = `${BASE}/products/${node.handle}`;
        const title = (detail?.title || node.title || 'Producto').trim();

        let text = `INFO: ${title}\n${resumen}\nURL: ${url}`;
        text = maybePrependGreetingTip(text, meta, FREE_TH);
        return res.json({ text });
      }

      // 3) Fallback de conocimiento (consejos cortos, sin links inventados)
      const ai = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: [
              'Eres un experto en limpieza para Chile.',
              'Responde en español (Chile), tono cercano y claro.',
              'Da pasos breves y prácticos (máx 5 bullets).',
              'NO inventes enlaces, precios ni productos específicos.',
              userFirstName ? `Si cabe, usa el nombre del usuario: ${userFirstName}.` : ''
            ].filter(Boolean).join(' ')
          },
          { role: 'user', content: message || '' }
        ]
      });
      const text = maybePrependGreetingTip(ai.choices[0].message.content, meta, FREE_TH);
      return res.json({ text });
    }

    /* ===== Ganchos previos (browse/buy) sin IA) ===== */
    if (isAskBestSellers(message || '')) {
      const items = await listTopSellers(5);
      let text = buildProductsMarkdown(items) || "Por ahora no tengo un ranking de más vendidos.";
      text = maybePrependGreetingTip(text, meta, FREE_TH);
      return res.json({ text });
    }

    const brand = extractBrandOrNull(message || '');
    if (brand) {
      const items = await searchByVendor(brand, 5);
      if (items.length) {
        let text = buildProductsMarkdown(items);
        text = maybePrependGreetingTip(text, meta, FREE_TH);
        return res.json({ text });
      }
      const fallback = await searchProductsPlain(brand, 5);
      if (fallback.length) {
        let text = buildProductsMarkdown(fallback);
        text = maybePrependGreetingTip(text, meta, FREE_TH);
        return res.json({ text });
      }
      return res.json({ text: `Sí trabajamos varias marcas. No encontré resultados exactos para "${brand}". ¿Quieres que te sugiera alternativas similares?` });
    }

    const mapped = synonymQueryOrNull(message || '');
    if (mapped) {
      const items = await searchProductsPlain(mapped, 5);
      if (items.length) {
        let text = buildProductsMarkdown(items);
        text = maybePrependGreetingTip(text, meta, FREE_TH);
        return res.json({ text });
      }
    }

    // 1 por zona (baño/cocina/horno)
    const qn = norm(message || '');
    const wantsBano   = /ba[nñ]o/.test(qn);
    const wantsCocina = /cocina/.test(qn);
    const wantsHorno  = /horno/.test(qn);
    if (wantsBano || wantsCocina || wantsHorno) {
      const zones = [];
      if (wantsBano) zones.push('baño');
      if (wantsCocina) zones.push('cocina');
      if (wantsHorno) zones.push('horno');
      const items = await recommendZoneProducts(zones);
      if (items.length) {
        const tip = 'TIP: Te dejo 1 sugerencia por zona. Si quieres alternativas (sin aroma, más eco, etc.) dime y ajusto.';
        let text = `${tip}\n\n${buildProductsMarkdown(items)}`;
        text = maybePrependGreetingTip(text, meta, FREE_TH);
        return res.json({ text });
      }
    }

    /* ===== Rama browse/buy con IA (tools) ===== */
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
                edges { node { ... on Product { title handle } } }
              }
            }
          `, { q: args.query });
          const items = (data.search?.edges || []).map(e => ({ title: e.node.title, handle: e.node.handle }));
          let text = buildProductsMarkdown(items);
          if (text) {
            text = maybePrependGreetingTip(text, meta, FREE_TH);
            return res.json({ text });
          }
        }

        if (c.function.name === 'getVariantByOptions') {
          const { handle, options = {} } = args;
          const p = await getProductJsonByHandle(handle);
          const vals = Object.values(options).map(v => String(v).toLowerCase().trim()).filter(Boolean);
          let match = null;
          for (const v of p.variants) {
            const pack = [v.title, v.option1, v.option2, v.option3]
              .filter(Boolean).map(s => String(s).toLowerCase().trim());
            const ok = vals.every(val => pack.some(piece => piece.includes(val)));
            if (ok) { match = v; break; }
          }
          if (!match) match = p.variants.find(v => v.available) || p.variants[0];
          if (!match) throw new Error('Sin variantes para ' + handle);
          return res.json({
            toolCalls: [{
              id: c.id,
              name: 'addToCartClient',
              arguments: { variantId: String(match.id), quantity: 1 }
            }]
          });
        }
      }
    }

    // Fallback 1: búsqueda directa simple
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
        text = maybePrependGreetingTip(text, meta, FREE_TH);
        return res.json({ text });
      }
    } catch (err) {
      console.warn('Fallback searchProducts failed:', err?.message || err);
    }

    // Fallback 2: pedir dato extra
    return res.json({
      text: userFirstName
        ? `Gracias, ${userFirstName}. ¿Me das una pista más (marca, superficie, aroma)? También puedo sugerir opciones similares.`
        : "No encontré resultados exactos. ¿Me das una pista más (marca, superficie, aroma)? También puedo sugerir opciones similares."
    });

  } catch (e) {
    console.error(e);
    if (e?.code === 'insufficient_quota' || e?.status === 429) {
      return res.json({
        text: "Estoy con alto tráfico. Dime qué producto buscas y te paso el enlace para agregarlo al carrito."
      });
    }
    return res.status(500).json({ error: String(e) });
  }
});

/* ---------------- Health ---------------- */
app.get('/health', (_, res) => res.json({ ok: true }));

const port = PORT || process.env.PORT || 3000;
app.listen(port, () => console.log('ML Chat server on :' + port));

