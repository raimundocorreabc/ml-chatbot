import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

const {
  OPENAI_API_KEY,
  SHOPIFY_STORE_DOMAIN,         // mundolimpio-cl.myshopify.com
  SHOPIFY_STOREFRONT_TOKEN,     // tu token Storefront
  SHOPIFY_PUBLIC_STORE_DOMAIN,  // https://www.mundolimpio.cl
  ALLOWED_ORIGINS,
  PORT
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

async function shopifyStorefrontGraphQL(query, variables={}) {
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
  const url = `${SHOPIFY_PUBLIC_STORE_DOMAIN.replace(/\/$/, '')}/products/${handle}.js`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('No se pudo leer ' + url);
  return r.json();
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'searchProducts',
      description: 'Busca productos por texto. Devuelve top 5 con handle y variantes.',
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
        properties: { handle: { type: 'string' }, options: { type: 'object', additionalProperties: { type: 'string' } } },
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
    return { items: (data.search.edges || []).map(e => e.node) };
  }

  if (name === 'getVariantByOptions') {
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
    return { variantId: String(match.id), variantTitle: match.title };
  }

  if (name === 'addToCartClient') return { __clientToolCall: true, ...args };
  if (name === 'getFAQ') return { answer: FAQS[args.topic] || '' };
  return {};
}

app.post('/chat', async (req, res) => {
  try {
    const { message, toolResult } = req.body;

    if (toolResult?.id) {
      const r = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Eres el asistente de MundoLimpio.cl. Responde breve y con CTA.' },
          { role: 'user', content: `Resultado de tool cliente: ${JSON.stringify(toolResult)}` }
        ]
      });
      return res.json({ text: r.choices[0].message.content });
    }

    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      tools,
      tool_choice: 'auto',
      messages: [
        { role: 'system', content:
          "Eres el asistente de MundoLimpio.cl. Si piden comprar: searchProducts→getVariantByOptions→addToCartClient. Para políticas: getFAQ. Español Chile y CTA." },
        { role: 'user', content: message || '' }
      ]
    });

    const msg = r.choices[0].message;
    if (msg.tool_calls?.length) {
      const calls = [];
      for (const c of msg.tool_calls) {
        const args = JSON.parse(c.function.arguments || '{}');
        const result = await toolRouter(c.function.name, args);
        if (result.__clientToolCall) calls.push({ id: c.id, name: c.function.name, arguments: args });
        else calls.push({ id: c.id, name: c.function.name, result });
      }
      const needsClient = calls.find(c => c.name === 'addToCartClient' && !c.result);
      if (needsClient) return res.json({ toolCalls: [{ id: needsClient.id, name: 'addToCartClient', arguments: needsClient.arguments }] });

      const follow = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Convierte resultados en respuesta breve con CTA.' },
          { role: 'user', content: JSON.stringify(calls) }
        ]
      });
      return res.json({ text: follow.choices[0].message.content });
    }

    res.json({ text: msg.content });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

// Render asigna PORT automáticamente:
const port = PORT || process.env.PORT || 3000;
app.listen(port, () => console.log('ML Chat server on :' + port));
