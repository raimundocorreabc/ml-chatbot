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

  // FAQs / Config
  FREE_SHIPPING_THRESHOLD_CLP, // si no está, usamos 40000 como default (RM)
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
app.use(cors({
  origin: (origin, cb) => (!origin || allowed.includes(origin)) ? cb(null, true) : cb(new Error('Origen no permitido')),
  credentials: true
}));

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ---------------- Utils generales ---------------- */
const BASE = (SHOPIFY_PUBLIC_STORE_DOMAIN || '').replace(/\/$/, '');
const FREE_TH_DEFAULT = 40000; // default consistente con tu banner de sitio (RM)

function formatCLP(n) {
  const v = Math.round(Number(n) || 0);
  return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(v);
}
function titleCaseComuna(s) { return String(s||'').toLowerCase().replace(/\b\w/g, m => m.toUpperCase()); }

// Normalización: quita tildes, pasa a minúsculas y pliega ñ→n (soporta "nunoa")
function norm(s=''){ return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }
function fold(s=''){ return norm(s).replace(/ñ/g,'n'); }

/* ---------------- Regiones y comunas (detección simple) ---------------- */
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

/* ---------------- Tools ---------------- */
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

/* ---------------- Helpers ---------------- */
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

/* ---------------- Intent ---------------- */
function detectIntent(text = '') {
  const qFold = fold((text || '').trim());
  const isComunaOnly = COMUNAS_FOLDED.has(qFold);
  const isRegionOnly = REGIONES_FOLDED.has(qFold);

  const infoTriggers = [
    'para que sirve','como usar','instrucciones','modo de uso','ingredientes','composicion',
    'sirve para','usos','beneficios','caracteristicas','como puedo','como sacar','como limpiar',
    'que es','envio','despacho','retiro','gratis','costo de envio','envio gratis',
    'mundopuntos','puntos','fidelizacion'
  ];
  const buyTriggers = ['comprar','agrega','agregar','añade','añadir','carrito','precio','recomiend'];

  if (isComunaOnly || isRegionOnly) return 'info';
  if (infoTriggers.some(t => qFold.includes(t))) return 'info';
  if (buyTriggers.some(t => qFold.includes(t))) return 'buy';
  return 'browse';
}

/* ------------- FAQs rápidas (sin tarjetas) ------------- */
function faqAnswerOrNull(message = '') {
  const raw = (message || '').trim();
  const qFold = fold(raw);

  const FREE_TH = Number(FREE_SHIPPING_THRESHOLD_CLP ?? FREE_TH_DEFAULT);
  const freeStrRM = FREE_TH > 0 ? `**envío gratis** desde **${formatCLP(FREE_TH)}**` : null;
  const destinosUrl = `${BASE}/pages/destinos-disponibles-en-chile`;

  // Región sola
  if (REGIONES_FOLDED.has(qFold)) {
    const isRM = /metropolitana|santiago/.test(qFold);
    const rmExtra = isRM && freeStrRM ? ` En RM, ${freeStrRM}.` : '';
    return `Hacemos despacho a **todo Chile**.${rmExtra} Para regiones, el costo se calcula en el checkout según **región y comuna** y peso. Frecuencias por zona: ${destinosUrl}`;
  }

  // Comuna sola
  if (COMUNAS_FOLDED.has(qFold)) {
    const idx = COMUNAS.findIndex(c => fold(c) === qFold);
    const comunaNice = idx >= 0 ? titleCaseComuna(COMUNAS[idx]) : titleCaseComuna(raw);
    const rmHint = freeStrRM ? ` En RM, ${freeStrRM}.` : '';
    return `Hacemos despacho a **todo Chile**.${rmHint} Para **${comunaNice}**, el costo se calcula en el checkout al ingresar **región y comuna**. Frecuencias por zona: ${destinosUrl}`;
  }

  // ENVÍOS genérico (mínimos/umbral/pedido por región+comuna)
  if (/(env[ií]o|envio|despacho|retiro)/i.test(raw)) {
    const base = `Hacemos despacho a **todo Chile**.`;
    if (/gratis|m[ií]nimo|minimo|sobre cu[aá]nto/i.test(raw)) {
      if (freeStrRM) return `${base} En **RM** ofrecemos ${freeStrRM}. Bajo ese monto, y para **regiones**, el costo se calcula en checkout según **región/comuna** y peso. ¿Para qué **región y comuna** lo necesitas? Frecuencias: ${destinosUrl}`;
      return `${base} El costo se calcula en checkout según **región/comuna** y peso. ¿Para qué **región y comuna** lo necesitas? Frecuencias: ${destinosUrl}`;
    }
    return `${base} El costo y tiempos dependen de **región/comuna** y peso. En el checkout verás las opciones disponibles. ¿Para qué **región y comuna**? Frecuencias: ${destinosUrl}`;
  }

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

  // HONGOS / MOHO EN BAÑO (guía rápida)
  if (/(hongo|moho).*(baño|ducha|tina)|sacar los hongos|sacar hongos/i.test(raw)) {
    return [
      `Para **hongos/moho en el baño**:`,
      `1) Ventila y usa guantes.`,
      `2) Aplica limpiador antihongos en juntas/silicona, deja actuar 5–10 min.`,
      `3) Frota con cepillo, enjuaga y seca.`,
      `¿Te recomiendo productos específicos según superficie (azulejo, silicona, cortina)?`
    ].join('\n');
  }

  return null;
}

/* ---------------- Endpoint principal ---------------- */
app.post('/chat', async (req, res) => {
  try {
    const { message, toolResult } = req.body;

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
      // 1) Intentar FAQ directa
      const faq = faqAnswerOrNull(message || '');
      if (faq) return res.json({ text: faq });

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
          ? (desc.length > 400 ? desc.slice(0, 400) + '…' : desc)
          : 'Es un limpiador multiusos diseñado para remover suciedad difícil de superficies compatibles.';
        const url = `${BASE}/products/${node.handle}`;
        const title = (detail?.title || node.title || 'Producto').trim();

        const text =
          `INFO: ${title}\n` +   // marcador para el front (render informativo sin tarjetas)
          `${resumen}\n` +
          `URL: ${url}`;

        return res.json({ text });
      }
      return res.json({ text: "¿De qué marca o tipo hablas exactamente? (ej: Astonish gel, Goo Gone, etc.) Así te doy el uso correcto y el enlace." });
    }

    /* ===== Rama browse/buy (con tools) ===== */
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
          const text = buildProductsMarkdown(items);
          if (text) return res.json({ text });
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
        const text = buildProductsMarkdown(items);
        if (text) return res.json({ text });
      }
    } catch (err) {
      console.warn('Fallback searchProducts failed:', err?.message || err);
    }

    // Fallback 2: pedir dato extra
    return res.json({
      text: "No encontré resultados exactos. ¿Me das una pista más (marca, superficie, aroma)? También puedo sugerir opciones similares."
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
