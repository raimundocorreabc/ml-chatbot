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

  // --- Opcionales para FAQs ---
  FREE_SHIPPING_THRESHOLD_CLP,     // ej: 24990
  MUNDOPUNTOS_EARN_PER_CLP,        // ej: 1   (1 punto por $1 CLP)
  MUNDOPUNTOS_REDEEM_PER_100,      // ej: 3   (100 puntos = $3 CLP)
  MUNDOPUNTOS_PAGE_URL             // ej: https://www.mundolimpio.cl/pages/mundopuntos
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

/* ---------------- Utils ---------------- */
const BASE = (SHOPIFY_PUBLIC_STORE_DOMAIN || '').replace(/\/$/, '');

function formatCLP(n) {
  const v = Math.round(Number(n) || 0);
  return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(v);
}

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

// Detalles por handle (incluye description)
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

function detectIntent(text = '') {
  const q = text.toLowerCase();

  // Preguntas claramente informativas / how-to / políticas
  const infoTriggers = [
    'para que sirve', 'para qué sirve', 'como usar', 'cómo usar',
    'instrucciones', 'modo de uso', 'ingredientes', 'composición',
    'sirve para', 'usos', 'beneficios', 'caracteristicas', 'características',
    'como puedo', 'cómo puedo', 'como sacar', 'cómo sacar', 'como limpiar', 'cómo limpiar',
    'que es', 'qué es',
    'hongo', 'moho', 'baño', 'tina', 'ducha',
    'envio', 'envío', 'despacho', 'retiro', 'gratis', 'costo de envío', 'envío gratis',
    'mundopuntos', 'puntos', 'fidelización', 'fidelizacion'
  ];

  // Claramente compra / precio
  const buyTriggers = [
    'comprar', 'agrega', 'agregar', 'añade', 'añadir',
    'carrito', 'precio', 'recomiend', 'recomiénd'
  ];

  if (infoTriggers.some(k => q.includes(k))) return 'info';
  if (buyTriggers.some(k => q.includes(k))) return 'buy';
  return 'browse';
}

/* ------------- FAQs rápidas (sin recomendar productos) ------------- */
function faqAnswerOrNull(message = '') {
  const q = message.toLowerCase();

  // ENVÍO / ENVÍO GRATIS
  if (/(env[ií]o|despacho|retiro)/.test(q)) {
    if (/gratis/.test(q) || /sobre cu[aá]nto/i.test(q) || /m[ií]nimo/.test(q)) {
      const th = Number(FREE_SHIPPING_THRESHOLD_CLP || 0);
      if (th > 0) {
        return `Tenemos **envío gratis** desde **${formatCLP(th)}** en zonas seleccionadas. Bajo ese monto, el costo se calcula al ingresar tu dirección en el checkout. ¿Te ayudo a verificar para tu comuna?`;
      }
      return `El costo de envío se calcula automáticamente en el checkout al ingresar tu dirección. Si me dices tu comuna puedo orientarte.`;
    }
    return `El costo y los tiempos de **envío** dependen de tu comuna y del peso del pedido. En el checkout verás las opciones disponibles. ¿Quieres que lo cotice por ti si me das comuna?`;
  }

  // MUNDOPUNTOS
  if (/mundopuntos|puntos|fidelizaci[óo]n/.test(q)) {
    const earn = Number(MUNDOPUNTOS_EARN_PER_CLP || 1);       // default: 1 punto = $1 CLP gastado
    const redeem100 = Number(MUNDOPUNTOS_REDEEM_PER_100 || 3); // default: 100 puntos = $3 CLP
    const url = MUNDOPUNTOS_PAGE_URL || `${BASE}/pages/mundopuntos`;
    return [
      `**Mundopuntos**: ganas **${earn} punto(s) por cada $1** que gastes.`,
      `El canje es **100 puntos = ${formatCLP(redeem100)}** (≈ ${(redeem100/100*100).toFixed(0)}% de retorno).`,
      `Puedes canjear en el checkout ingresando tu cupón. Más info: ${url}`
    ].join('\n');
  }

  // HONGOS / MOHO EN BAÑO
  if (/(hongo|moho).*(baño|ducha|tina)|sacar los hongos|sacar hongos/.test(q)) {
    return [
      `Para **hongos/moho en el baño**:`,
      `1) Ventila y protege guantes.`,
      `2) Aplica el limpiador antihongos en juntas/silicona, deja actuar 5–10 min.`,
      `3) Frota con cepillo, enjuaga bien y seca.`,
      `¿Quieres que te recomiende productos específicos para tu superficie (azulejo, silicona, cortina, etc.)?`
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
      // 1) Primero, intenta respuesta de FAQ
      const faq = faqAnswerOrNull(message || '');
      if (faq) return res.json({ text: faq });

      // 2) Si no es FAQ, intenta extraer info de un producto relacionado
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
          `INFO: ${title}\n` +   // ← marcador para el front (render informativo sin tarjetas)
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

