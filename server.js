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
  MUNDOPUNTOS_PAGE_URL,

  // Carrusel de marcas (opcional): JSON de [{title,url,image}]
  BRAND_CAROUSEL_JSON
} = process.env;

if (!OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY");
if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_STOREFRONT_TOKEN) throw new Error("Falta SHOPIFY_STORE_DOMAIN o SHOPIFY_STOREFRONT_TOKEN");
if (!SHOPIFY_PUBLIC_STORE_DOMAIN) throw new Error("Falta SHOPIFY_PUBLIC_STORE_DOMAIN");

// CORS
const allowed = (ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Asegura incluir tu dominio público de Shopify
// p.ej: https://tienda.myshopify.com o https://www.mundolimpio.cl

const app = express();
app.use(express.json());
app.use(cors({
  origin: (origin, cb) => (!origin || allowed.includes(origin)) ? cb(null, true) : cb(new Error('Origen no permitido')),
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
function titleCase(s) { return String(s||'').toLowerCase().replace(/\b\w/g, m => m.toUpperCase()); }
function norm(s=''){ return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }
function fold(s=''){ return norm(s).replace(/ñ/g,'n'); }

/* ---------------- Regiones/comunas (intención “envío”) ---------------- */
// Canonical (para matching flexible tipo “includes”)
const REGION_CANON = [
  'arica y parinacota','tarapaca','antofagasta','atacama','coquimbo','valparaiso',
  'metropolitana','santiago',"o'higgins",'ohiggins','maule','nuble','biobio',
  'la araucania','araucania','los rios','los lagos','aysen','magallanes'
];

// Función robusta: encuentra una región dentro de un texto en español (RM, “región de …”, etc.)
function findRegionInText(text='') {
  const f = ' ' + fold(text) + ' ';

  // Abreviatura/alias RM
  if (/\brm\b/.test(f) || f.includes(' region metropolitana ') || f.includes(' region metropolitana de santiago ')) {
    return 'metropolitana';
  }

  // “Santiago” lo consideramos RM
  if (f.includes(' santiago ')) return 'metropolitana';

  // “región de X” o “region X” o nombre suelto
  for (const canon of REGION_CANON) {
    if (
      f.includes(' ' + canon + ' ') ||
      f.includes(' region ' + canon + ' ') ||
      f.includes(' region de ' + canon + ' ')
    ) return canon;
  }
  return null;
}

// Un set pequeño de comunas frecuentes (para mejorar heurística)
// Si quieres, puedes ampliarlo, pero si no se reconoce pedimos región para confirmar.
const COMUNAS_POP = [
  'las condes','vitacura','lo barnechea','providencia','ñuñoa','la reina','santiago',
  'macul','la florida','puente alto','maipú','maipu','huechuraba','independencia','recoleta','quilicura',
  'conchalí','conchali','san miguel','san joaquín','san joaquin','la cisterna','san bernardo','colina','buin','lampa'
];
function findComunaInText(text='') {
  const f = ' ' + fold(text) + ' ';
  for (const c of COMUNAS_POP) {
    const cf = ' ' + fold(c) + ' ';
    if (f.includes(cf)) return c;
  }
  // patrón “comuna de X” (heurístico)
  const m = f.match(/\bcomuna(?:\s+de)?\s+([a-z\s]{3,30})\b/);
  if (m && m[1] && !m[1].includes('region')) return m[1].trim();
  return null;
}

/* ---------------- Tarifas de envío por zona ---------------- */
const SHIPPING_ZONES = [
  { zone: 'REGIÓN METROPOLITANA', cost: 3990,  regions: ['Metropolitana','Santiago'] },
  { zone: 'ZONA CENTRAL',         cost: 6990,  regions: ['Coquimbo','Valparaíso','Valparaiso',"O’Higgins","O'Higgins",'Maule','Ñuble','Nuble','Biobío','Biobio','Araucanía','Araucania','Los Ríos','Los Rios','Los Lagos'] },
  { zone: 'ZONA NORTE',           cost: 10990, regions: ['Arica y Parinacota','Tarapacá','Tarapaca','Antofagasta','Atacama'] },
  { zone: 'ZONA AUSTRAL',         cost: 14990, regions: ['Aysén','Aysen','Magallanes'] }
];
const REGION_COST_MAP = (() => {
  const m = new Map();
  for (const z of SHIPPING_ZONES)
    for (const r of z.regions)
      m.set(fold(r), { zone: z.zone, cost: z.cost });
  m.set('metropolitana', { zone: 'REGIÓN METROPOLITANA', cost: 3990 });
  m.set('santiago',      { zone: 'REGIÓN METROPOLITANA', cost: 3990 });
  return m;
})();
function shippingByRegionName(input='') {
  return REGION_COST_MAP.get(fold(input)) || null;
}

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

async function recommendZoneProducts(zones = []) {
  const queries = {
    'baño':   ['antihongos baño', 'astonish baño 750', 'limpiador baño'],
    'cocina': ['desengrasante cocina', 'cif crema', 'astonish kitchen'],
    'horno':  ['astonish horno', 'goo gone bbq', 'weiman cook top']
  };
  const picks = [];
  const seen = new Set();
  for (const z of zones) {
    const qs = queries[z] || [];
    let found = null;
    for (const q of qs) {
      const items = await searchProductsPlain(q, 2);
      const it = items.find(i => !seen.has(i.handle));
      if (it) { found = it; break; }
    }
    if (found) { picks.push(found); seen.add(found.handle); }
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
  return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// TIP de saludo + progreso a envío gratis (solo una vez y si hay algo en carrito)
function maybePrependGreetingTip(text, meta, FREE_TH) {
  const name = (meta?.userFirstName || '').trim();
  const already = !!meta?.tipAlreadyShown;
  if (!name || already) return text;

  const sub = Number(meta?.cartSubtotalCLP || 0);
  const hasCart = Number.isFinite(sub) && sub > 0;
  const extra = (hasCart && FREE_TH > 0 && sub < FREE_TH) ? ` | Te faltan ${formatCLP(FREE_TH - sub)} para envío gratis en RM` : '';
  return `TIP: Hola, ${name} 👋${extra}\n\n${text}`;
}

/* ---------------- Carrusel de marcas ---------------- */
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

/* ---------------- Intent ---------------- */
function detectIntent(text = '') {
  const qFold = fold((text || '').trim());
  const infoTriggers = [
    'para que sirve','como usar','instrucciones','modo de uso','ingredientes','composicion',
    'sirve para','usos','beneficios','caracteristicas','consejos','tips','que es',
    'envio','envío','despacho','retiro','gratis','costo de envio','envio gratis',
    'mundopuntos','puntos','fidelizacion','checkout','cupon','codigo de descuento',
    'marcas venden','tipos de productos','que productos venden','que venden'
  ];
  const buyTriggers = ['comprar','agrega','agregar','añade','añadir','carrito','precio','recomiend'];

  // Nuevo: si el texto contiene alguna región/comuna conocida, trátalo como “info” (envío)
  if (findRegionInText(text) || findComunaInText(text)) return 'info';
  if (infoTriggers.some(t => qFold.includes(fold(t)))) return 'info';
  if (buyTriggers.some(t => qFold.includes(fold(t)))) return 'buy';
  return 'browse';
}

/* ---------------- Multi-búsqueda incremental ---------------- */
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

/* ==================== FAQ/guías (envíos + varios) ==================== */
async function faqAnswerOrNull(message = '', meta = {}) {
  const raw = (message || '').trim();

  // Si el front envió "envío <lugar>", extraemos <lugar>; si no, usamos el texto tal cual.
  const mPref = raw.match(/^(env[ií]o|envio|despacho|retiro)\s+(.+)$/i);
  const locationOnly = mPref ? mPref[2] : raw;

  const FREE_TH = Number(FREE_SHIPPING_THRESHOLD_CLP ?? FREE_TH_DEFAULT);
  const destinosUrl = `${BASE}/pages/destinos-disponibles-en-chile`;

  // Detecciones robustas
  const regionFound = findRegionInText(locationOnly); // ej: "rm" → "metropolitana"
  const comunaFound = findComunaInText(locationOnly); // ej: "en la comuna de la florida" → "la florida"

  // --- Región detectada ---
  if (regionFound) {
    const ship = shippingByRegionName(regionFound);
    const isRM = regionFound === 'metropolitana';
    let parts = [];

    if (ship) {
      const niceRegion = titleCase(regionFound.replace(/^la\s+/,'La '));
      const comunaBit = comunaFound ? `, comuna **${titleCase(comunaFound)}**` : '';
      parts.push(`Para **${niceRegion}**${comunaBit} (${ship.zone}), el costo referencial es **${formatCLP(ship.cost)}**.`);
    } else {
      parts.push(`Para tu región el costo se calcula en el **checkout** según **región/comuna** y peso.`);
    }

    if (isRM && FREE_TH > 0) {
      parts.push(`En **RM** ofrecemos **envío gratis** sobre **${formatCLP(FREE_TH)}** (bajo ese monto: ${formatCLP(3990)}).`);
    }
    parts.push(`📦 Frecuencias/zonas: ${destinosUrl}`);
    return parts.join(' ');
  }

  // --- Solo comuna detectada ---
  if (comunaFound) {
    const comunaNice = titleCase(comunaFound);
    return `Hacemos despacho a **todo Chile**. Para **${comunaNice}**, el costo se calcula automáticamente en el **checkout** al ingresar **región y comuna**. Si me confirmas la **región**, te digo el costo referencial. 📦 Frecuencias: ${destinosUrl}`;
  }

  // --- Pregunta genérica de envíos ---
  if (/(env[ií]o|envio|despacho|retiro)/i.test(raw)) {
    const header = FREE_TH > 0
      ? `En la **Región Metropolitana (RM)** ofrecemos **envío gratis** en compras sobre **${formatCLP(FREE_TH)}**.`
      : `Hacemos despacho a **todo Chile**.`;
    const para2 = `Para pedidos bajo ese monto en RM, y para **todas las regiones**, el costo se calcula automáticamente en el **checkout** según **región y comuna**.`;
    const para3 = `Si me indicas tu **región** y **comuna**, te confirmo el **costo** y la **frecuencia** en tu zona.`;
    const para4 = `📦 Frecuencias: ${destinosUrl}`;
    const tarifas =
      `Tarifas referenciales por región:\n` +
      `- **RM**: ${formatCLP(3990)}\n` +
      `- **Zona Central**: ${formatCLP(6990)}\n` +
      `- **Zona Norte**: ${formatCLP(10990)}\n` +
      `- **Zona Austral**: ${formatCLP(14990)}`;
    return [header, '', para2, '', para3, para4, '', tarifas].join('\n');
  }

  // ¿Dónde canjear cupón en checkout?
  if (/(donde|en que parte|cómo|como).*(checkout|pago|carro|carrito).*(cupon|cup[oó]n|c[oó]digo de descuento|codigo de descuento)/i.test(raw)) {
    return [
      `En el **checkout** (primera pantalla) verás el campo **“Código de descuento o tarjeta de regalo”**.`,
      `Pega tu cupón y presiona **Aplicar**.`,
      `Si es un cupón de **Mundopuntos**, primero géneralo en el **widget de recompensas** y luego cópialo en ese campo.`
    ].join(' ');
  }

  // ¿Qué es ML / Qué venden? → categorías
  if (/(que es|qué es|quienes son|quiénes son).*(mundolimpio|mundo limpio)|que venden en mundolimpio|que productos venden\??$/i.test(raw)) {
    const cols = await listCollections(8);
    if (!cols.length) return `**MundoLimpio.cl** es una tienda chilena de limpieza/hogar premium.`;
    const payload = cols.map(c => `${c.title}|${BASE}/collections/${c.handle}`).join('\n');
    return `CATS:\n${payload}`;
  }

  // ¿Qué marcas venden? → carrusel
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

  // ¿Qué tipos/categorías venden? → categorías
  if (/(que|qué)\s+tipos\s+de\s+productos\s+venden|categor[ií]as|secciones|colecciones/i.test(raw)) {
    const cols = await listCollections(10);
    if (!cols.length) return 'Tenemos múltiples categorías: cocina, baño, pisos, lavandería, superficies, accesorios y más.';
    const payload = cols.map(c => `${c.title}|${BASE}/collections/${c.handle}`).join('\n');
    return `CATS:\n${payload}`;
  }

  // Tips + recomendaciones rápidas
  if (/vitrocer[aá]mica|vitro\s*cer[aá]mica/i.test(raw)) {
    const tip = [
      'Vitrocerámica — pasos rápidos:',
      '1) Con la placa fría, rasqueta plástica.',
      '2) Aplica crema específica 1–2 min.',
      '3) Microfibra y repite en manchas.',
      '4) Finaliza con protector si quieres brillo.'
    ].join('\n');
    const items = await searchMulti(['weiman vitroceramica crema', 'weiman cook top kit', 'astonish vitroceramica'], 3);
    const list = buildProductsMarkdown(items);
    return list ? `TIP: ${tip}\n\n${list}` : `TIP: ${tip}`;
  }

  if (/alfombra(s)?/i.test(raw)) {
    const tip = [
      'Alfombra — limpieza básica:',
      '1) Aspira a fondo.',
      '2) Prueba en zona oculta.',
      '3) Limpiador de alfombras, cepilla y retira.',
      '4) Seca con ventilación.'
    ].join('\n');
    const items = await searchMulti(['alfombra limpiador', 'tapicerias astonish', 'protector textil'], 3);
    const list = buildProductsMarkdown(items);
    return list ? `TIP: ${tip}\n\n${list}` : `TIP: ${tip}`;
  }

  if (/olla.*quemad/i.test(raw)) {
    const tip = [
      'Olla quemada — cómo salvarla:',
      '1) Agua + bicarbonato (o vinagre) y hierve 5 min.',
      '2) Enfría y desprende con espátula.',
      '3) Pasta desengrasante y enjuaga.',
      '4) En inox, limpiador específico.'
    ].join('\n');
    const items = await searchMulti(['pink stuff pasta 850', 'astonish vitroceramica kit', 'weiman acero inoxidable 710'], 3);
    const list = buildProductsMarkdown(items);
    return list ? `TIP: ${tip}\n\n${list}` : `TIP: ${tip}`;
  }

  return null;
}

/* ---------------- Endpoint principal ---------------- */
app.post('/chat', async (req, res) => {
  try {
    const { message, toolResult, meta = {} } = req.body;
    const userFirstName = (meta.userFirstName || '').trim();
    const FREE_TH = Number(FREE_SHIPPING_THRESHOLD_CLP ?? FREE_TH_DEFAULT);

    // Respuesta post-tool (addToCartClient)
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

    /* ===== Rama informativa / FAQs (incluye envíos) ===== */
    if (intent === 'info') {
      const faq = await faqAnswerOrNull(message || '', meta);
      if (faq) {
        const withTip = maybePrependGreetingTip(faq, meta, FREE_TH);
        return res.json({ text: withTip });
      }

      // Producto relacionado (resumen corto)
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
        const resumen = desc ? (desc.length > 300 ? desc.slice(0, 300) + '…' : desc)
                             : 'Es un limpiador multiusos diseñado para remover suciedad difícil de superficies compatibles.';
        let text = `INFO: ${(detail?.title || node.title || 'Producto').trim()}\n${resumen}\nURL: ${BASE}/products/${node.handle}`;
        text = maybePrependGreetingTip(text, meta, FREE_TH);
        return res.json({ text });
      }

      // Consejos compactos por IA (sin links inventados)
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

    /* ===== Ganchos previos (browse/buy) sin IA ===== */
    const qn = fold(message || '');
    if (/(mas vendidos|más vendidos|best sellers|top ventas|lo mas vendido|lo más vendido)/.test(qn)) {
      const items = await listTopSellers(5);
      let text = buildProductsMarkdown(items) || "Por ahora no tengo un ranking de más vendidos.";
      text = maybePrependGreetingTip(text, meta, FREE_TH);
      return res.json({ text });
    }

    const mBrand = (message || '').toLowerCase().match(/tienen la marca\s+([a-z0-9&\-\s]+)/i)
                || (message || '').toLowerCase().match(/tienen\s+([a-z0-9&\-\s]+)\??$/i);
    if (mBrand) {
      const brand = mBrand[1].trim();
      if (brand.length >= 2 && brand.length <= 40) {
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
    }

    if (/pasta.*(rosada|pink)|pink.*stuff/i.test(qn)) {
      const items = await searchProductsPlain('pink stuff pasta multiuso stardrops', 5);
      if (items.length) {
        let text = buildProductsMarkdown(items);
        text = maybePrependGreetingTip(text, meta, FREE_TH);
        return res.json({ text });
      }
    }
    if (/pasta.*(original|astonish)|astonish.*pasta/i.test(qn)) {
      const items = await searchProductsPlain('astonish pasta original multiuso', 5);
      if (items.length) {
        let text = buildProductsMarkdown(items);
        text = maybePrependGreetingTip(text, meta, FREE_TH);
        return res.json({ text });
      }
    }
    if (/ecolog|eco|biodegrad/i.test(qn)) {
      const items = await searchProductsPlain('ecologico biodegradable eco plant-based', 5);
      if (items.length) {
        let text = buildProductsMarkdown(items);
        text = maybePrependGreetingTip(text, meta, FREE_TH);
        return res.json({ text });
      }
    }

    // 1 por zona (baño/cocina/horno)
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

    // Fallback: búsqueda directa
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
    } catch (err) { console.warn('Fallback searchProducts failed:', err?.message || err); }

    // Fallback final
    const name = (meta?.userFirstName || '').trim();
    return res.json({
      text: name
        ? `Gracias, ${name}. ¿Me das una pista más (marca, superficie, aroma)? También puedo sugerir opciones similares.`
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

/* ---------------- Health ---------------- */
app.get('/health', (_, res) => res.json({ ok: true }));

const port = PORT || process.env.PORT || 3000;
app.listen(port, () => console.log('ML Chat server on :' + port));

