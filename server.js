import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

const {
  OPENAI_API_KEY,
  SHOPIFY_STORE_DOMAIN,         // p.ej. mundolimpio-cl.myshopify.com
  SHOPIFY_STOREFRONT_TOKEN,     // token Storefront
  SHOPIFY_PUBLIC_STORE_DOMAIN,  // p.ej. https://www.mundolimpio.cl
  ALLOWED_ORIGINS,
  PORT
} = process.env;

if (!OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY");
if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_STOREFRONT_TOKEN) throw new Error("Falta SHOPIFY_STORE_DOMAIN o SHOPIFY_STOREFRONT_TOKEN");
if (!SHOPIFY_PUBLIC_STORE_DOMAIN) throw new Error("Falta SHOPIFY_PUBLIC_STORE_DOMAIN");

const allowed = (ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const app = express();
app.use(express.json());
app.use(cors({
  origin: (origin, cb) => (!origin || allowed.includes(origin)) ? cb(null, true) : cb(new Error('Origen no permitido')),
  credentials: true
}));

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* -------------------- Utils Shopify -------------------- */
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

// JSON público (para obtener ID numérico de variante para /cart/add.js)
async function getProductJsonByHandle(handle) {
  const url = `${SHOPIFY_PUBLIC_STORE_DOMAIN.replace(/\/$/, '')}/products/${handle}.js`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('No se pudo leer ' + url);
  return r.json();
}

/* -------------------- Tools (function calling) -------------------- */
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
  },
  {
    type: 'function',
    function: {
      name: 'getFAQ',
      description: 'FAQ canónicas (envíos, cambios, pagos, puntos).',
      parameters: { type: 'object', properties: { topic: { type: 'string', enum: ['envios','cambios','pagos','puntos'] } }, required: ['topic'] }
    }
  }
];

const FAQS = {
  envios: "Envíos a todo Chile. RM: 1–2 días hábiles; Regiones: 2–5 días según courier.",
  cambios: "10 días cambios por preferencia y 6 meses por fallas. Sin uso y con empaque original.",
  pagos: "Débito/crédito y Mercado Pago. Transferencia previa para empresas.",
  puntos: "1 mundopunto por cada $1.000 CLP. Canje en checkout en 'Código de descuento o tarjeta de regalo'."
};

/* -------------------- Tool Router -------------------- */
async function toolRouter(name, args) {
  if (name === 'searchProducts') {
    const data = await shopifyStorefrontGraphQL(`
      query ProductSearch($q: String!) {
        search(query: $q, types: PRODUCT, first: 5) {
          edges { node { ... on Product {
            id title handle vendor productType
            variants(first: 50) { edges { node {
              id title availableForSale
              price: priceV2 { amount currencyCode }
              selectedOptions { name value }
            } } }
          } } }
        }
      }
    `, { q: args.query });

    const base = SHOPIFY_PUBLIC_STORE_DOMAIN.replace(/\/$/, '');
    const items = (data.search.edges || []).map(e => {
      const p = e.node;
      return {
        id: p.id,
        title: p.title,
        handle: p.handle,
        url: `${base}/products/${p.handle}`, // URL real en tu dominio
        vendor: p.vendor,
        productType: p.productType,
        variants: (p.variants?.edges || []).map(v => ({
          id: v.node.id,
          title: v.node.title,
          availableForSale: v.node.availableForSale,
          price: v.node.price, // { amount, currencyCode }
          selectedOptions: v.node.selectedOptions
        }))
      };
    });
    return { items };
  }

  if (name === 'getVariantByOptions') {
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
    return { variantId: String(match.id), variantTitle: match.title };
  }

  if (name === 'addToCartClient') return { __clientToolCall: true, ...args };
  if (name === 'getFAQ') return { answer: FAQS[args.topic] || '' };
  return {};
}

/* -------------------- Endpoint principal -------------------- */
app.post('/chat', async (req, res) => {
  try {
    const { message, toolResult } = req.body;

    // Respuesta posterior a ejecutar una tool en el cliente
    if (toolResult?.id) {
      const r = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: [
              "Eres el asistente de MundoLimpio.cl.",
              "Nunca inventes productos, precios ni enlaces.",
              "Si hablas de productos, usa SIEMPRE resultados reales que te entregue el sistema o las herramientas.",
              "Responde breve y con CTA."
            ].join(' ')
          },
          { role: 'user', content: `Resultado de tool cliente: ${JSON.stringify(toolResult)}` }
        ]
      });
      return res.json({ text: r.choices[0].message.content });
    }

    // Flujo normal
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
            "Para recomendar productos DEBES usar la función searchProducts y basarte en sus resultados.",
            "Cuando listes productos, incluye el título y el enlace REAL usando el campo 'url' que te entrega el sistema (no construyas enlaces manualmente).",
            "Si no hay resultados, pide 1 dato extra (por ejemplo: marca, fragancia, superficie) o ofrece alternativas del catálogo.",
            "Para agregar al carrito: getVariantByOptions -> addToCartClient.",
            "Para políticas: getFAQ.",
            "Español Chile, tono claro y con CTA."
          ].join(' ')
        },
        { role: 'user', content: message || '' }
      ]
    });

    const msg = r.choices[0].message;

    // ¿El modelo pidió herramientas?
    if (msg.tool_calls?.length) {
      const calls = [];
      for (const c of msg.tool_calls) {
        const args = JSON.parse(c.function.arguments || '{}');
        const result = await toolRouter(c.function.name, args);
        if (result.__clientToolCall) {
          calls.push({ id: c.id, name: c.function.name, arguments: args });
        } else {
          calls.push({ id: c.id, name: c.function.name, result });
        }
      }

      // Si hay que ejecutar en el cliente (agregar al carrito)
      const needsClient = calls.find(c => c.name === 'addToCartClient' && !c.result);
      if (needsClient) {
        return res.json({ toolCalls: [{ id: needsClient.id, name: 'addToCartClient', arguments: needsClient.arguments }] });
      }

      // Segunda pasada: el modelo convierte resultados en texto (con URLs reales incluidas en 'result')
      const follow = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: [
              "Convierte los resultados de herramientas en una respuesta corta y útil.",
              "Usa solo los datos entregados por las herramientas.",
              "Cuando muestres productos, usa el campo 'url' proporcionado (no inventes links).",
              "Incluye CTA: ofrece agregar al carrito o ver más detalles."
            ].join(' ')
          },
          { role: 'user', content: JSON.stringify(calls) }
        ]
      });
      return res.json({ text: follow.choices[0].message.content });
    }

    /* ---------- Fallback: si el modelo NO usó tools, forzamos búsqueda ---------- */
    try {
      const forced = await toolRouter('searchProducts', { query: String(message || '').slice(0, 120) });
      const items = forced?.items || [];
      if (items.length > 0) {
        const calls = [{ id: 'manual_search', name: 'searchProducts', result: { items } }];
        const follow = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: [
                "Convierte los resultados de herramientas en una respuesta corta y útil.",
                "Usa solo los datos entregados por las herramientas.",
                "Cuando muestres productos, usa el campo 'url' proporcionado (no inventes links).",
                "Incluye CTA: ofrece agregar al carrito o ver más detalles."
              ].join(' ')
            },
            { role: 'user', content: JSON.stringify(calls) }
          ]
        });
        return res.json({ text: follow.choices[0].message.content });
      }
    } catch (err) {
      console.warn('Fallback searchProducts failed:', err?.message || err);
    }

    // Si tampoco hay resultados, pedimos un dato extra
    return res.json({
      text: "¿Me das un poco más de detalle para ayudarte mejor? Por ejemplo: marca, tipo de superficie (azulejos, porcelanato) o si buscas un removedor de moho específico."
    });

  } catch (e) {
    console.error(e);
    // Fallback amable si hay errores de cuota u otros
    if (e?.code === 'insufficient_quota' || e?.status === 429) {
      return res.json({
        text: "Por ahora no puedo generar respuesta automática. Dime qué producto buscas y te paso el enlace real para agregarlo al carrito."
      });
    }
    res.status(500).json({ error: String(e) });
  }
});

/* -------------------- Healthcheck -------------------- */
app.get('/health', (_, res) => res.json({ ok: true }));

// Render asigna PORT automáticamente
const port = PORT || process.env.PORT || 3000;
app.listen(port, () => console.log('ML Chat server on :' + port));
