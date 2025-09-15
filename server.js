// server.js — versión simplificada AI-first
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
  FREE_SHIPPING_THRESHOLD_CLP,
  MUNDOPUNTOS_EARN_PER_CLP,
  MUNDOPUNTOS_REDEEM_PER_100,
  MUNDOPUNTOS_PAGE_URL,
  BRAND_CAROUSEL_JSON,
  BEST_SELLERS_COLLECTION_HANDLE
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

/* ---------- Utils ---------- */
const SF_API_VERSION = '2025-01';
const BASE = (SHOPIFY_PUBLIC_STORE_DOMAIN || '').replace(/\/$/, '');
const FREE_TH_DEFAULT = 40000;

const nrm = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const fold = s => nrm(s).replace(/ñ/g,'n');
const formatCLP = n => new Intl.NumberFormat('es-CL',{style:'currency',currency:'CLP',maximumFractionDigits:0}).format(Math.round(Number(n)||0));
const stripHtml = s => String(s).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();

async function gql(query, variables = {}) {
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

async function searchProductsPlain(query, first = 5) {
  const d = await gql(`
    query($q:String!,$n:Int!){
      search(query:$q, types: PRODUCT, first:$n){
        edges{ node{ ... on Product { title handle availableForSale } } }
      }
    }
  `, { q: query, n: first });
  return (d.search?.edges||[]).map(e=>({ title:e.node.title, handle:e.node.handle, availableForSale: !!e.node.availableForSale }));
}

async function listTopSellers(first = 8) {
  const handle = (BEST_SELLERS_COLLECTION_HANDLE||'').trim();
  // Preferir colección definida (tu vitrina real)
  if (handle) {
    try {
      const d = await gql(`
        query($h:String!,$n:Int!){
          collectionByHandle(handle:$h){
            products(first:$n, sortKey: BEST_SELLING){
              edges{ node{ title handle availableForSale } }
            }
          }
        }
      `, { h: handle, n:first });
      const items = (d.collectionByHandle?.products?.edges||[]).map(e=>({title:e.node.title,handle:e.node.handle,availableForSale:!!e.node.availableForSale}));
      if (items.length) return items;
      console.warn('[top-sellers] Colección vacía o handle inválido:', handle);
    } catch(err){ console.warn('[top-sellers] error colección', err?.message||err); }
  }
  // Fallback global
  try {
    const d = await gql(`
      query($n:Int!){
        products(first:$n, sortKey: BEST_SELLING){
          edges{ node{ title handle availableForSale } }
        }
      }
    `, { n:first });
    const items = (d.products?.edges||[]).map(e=>({title:e.node.title,handle:e.node.handle,availableForSale:!!e.node.availableForSale}));
    if (items.length) return items;
  } catch(err){ console.warn('[top-sellers] error global', err?.message||err); }
  // Último recurso cualquiera
  const any = await gql(`
    query($n:Int!){
      products(first:$n){ edges{ node{ title handle availableForSale } } }
    }
  `, { n:first });
  return (any.products?.edges||[]).map(e=>({title:e.node.title,handle:e.node.handle,availableForSale:!!e.node.availableForSale}));
}

function buildProductsMarkdown(items = []) {
  if (!items.length) return null;
  return `Aquí tienes opciones:\n\n` + items.map((p,i)=>`${i+1}. **[${(p.title||'Ver producto').replace(/\*/g,'')}](${BASE}/products/${p.handle})**`).join('\n');
}

async function preferInStock(items, need) {
  // Ligero: prioriza `availableForSale` si viene; si no, deja orden tal cual
  const inStock = items.filter(x=>x.availableForSale);
  const rest = items.filter(x=>!x.availableForSale);
  const out = inStock.concat(rest).slice(0, need);
  // de-dup por handle
  const seen = new Set(); return out.filter(x=>!seen.has(x.handle) && seen.add(x.handle));
}

/* ---------- IA: política y detección ---------- */
const AI_POLICY = `
Eres el asistente de MundoLimpio.cl (Chile), experto en limpieza.
1) Responde PRIMERO con un mini plan (3–5 bullets) claro y seguro.
2) Solo si aporta valor, sugiere 1–3 tipos de producto (no inventes marcas ni precios).
3) Tono cercano, breve, con CTA suave al final ("¿Te sugiero 2 opciones?").
No inventes enlaces ni disponibilidad.
`;
const PURPOSE_REGEX = /\b(para que sirve|para qué sirve|que es|qué es|como usar|cómo usar|modo de uso|instrucciones|paso a paso|como limpiar|cómo limpiar|consejos|tips|guia|guía|pasos)\b/i;

function detectIntent(text='') {
  const q = nrm(text);
  if (/(mas vendidos|más vendidos|best sellers|top ventas|lo mas vendido|lo más vendido)/.test(q)) return 'tops';
  if (PURPOSE_REGEX.test(text)) return 'info';
  if (/(envio|env[ií]o|despacho|retiro|mundopuntos|cup[oó]n|c[oó]digo de descuento|marcas|categorias|categorías)/i.test(text)) return 'faq';
  return 'browse';
}

/* ---------- Rewriter mínimo para queries ambiguas ---------- */
function smartRewrite(message='') {
  const q = nrm(message);
  if (/\bpapeles?\b/.test(q)) return ['papel higienico','toalla de papel','servilletas'];
  if (/(sticker|adhesivo|pegatina)/.test(q) && /(notebook|computador|laptop|pc|mac)/.test(q))
    return ['removedor adhesivo','goo gone','alcohol isopropilico'];
  return null;
}

/* ---------- FAQs de negocio (las que sí conviene hardcodear) ---------- */
function parseBrandCarouselConfig(){ try { return JSON.parse(BRAND_CAROUSEL_JSON||''); } catch { return []; } }
async function faqAnswer(message) {
  const q = nrm(message);
  const FREE_TH = Number(FREE_SHIPPING_THRESHOLD_CLP ?? FREE_TH_DEFAULT);
  const destinosUrl = `${BASE}/pages/destinos-disponibles-en-chile`;

  if (/(envio|env[ií]o|despacho|retiro)/.test(q)) {
    return [
      FREE_TH>0 ? `En **RM** hay **envío gratis** sobre **${formatCLP(FREE_TH)}**.` : `Hacemos despacho a **todo Chile**.`,
      `El costo exacto se calcula en el **checkout** según región y comuna.`,
      `¿Me indicas tu región y comuna?`,
      `Frecuencias por zona: ${destinosUrl}`
    ].join(' ');
  }

  if (/(cupon|cup[oó]n|c[oó]digo de descuento|codigo de descuento)/.test(q)) {
    return `En el **checkout** verás el campo “Código de descuento o tarjeta de regalo”. Pega tu cupón y presiona **Aplicar**.`;
  }

  if (/mundopuntos|puntos|fidelizaci[óo]n/.test(q)) {
    const earn = Number(MUNDOPUNTOS_EARN_PER_CLP || 1);
    const redeem100 = Number(MUNDOPUNTOS_REDEEM_PER_100 || 3);
    const url = (MUNDOPUNTOS_PAGE_URL || '').trim();
    return `**Mundopuntos**: ganas **${earn} punto(s) por $1**. Canje: **100 puntos = ${formatCLP(redeem100)}**. ${url?`Más info: ${url}`:'Puedes gestionarlo en el widget de recompensas.'}`;
  }

  if (/(que|qué)\s+marcas/.test(q)) {
    const custom = parseBrandCarouselConfig();
    if (custom.length) return `BRANDS:\n` + custom.map(b=>[b.title,b.url,b.image||''].join('|')).join('\n');
    return `Trabajamos varias marcas. ¿Cuál te interesa?`;
  }

  if (/(categorias|categorías|colecciones|tipos de productos)/.test(q)) {
    // Si quieres: podríamos listar 6–8 colecciones, pero lo simplifico
    return `Tenemos limpieza de cocina, baño, pisos, lavandería, superficies y accesorios. ¿Sobre cuál te ayudo?`;
  }

  return null;
}

/* ---------- Endpoint ---------- */
app.post('/chat', async (req, res) => {
  try {
    const { message, toolResult, meta = {} } = req.body;
    const FREE_TH = Number(FREE_SHIPPING_THRESHOLD_CLP ?? FREE_TH_DEFAULT);

    // Post tool (cart add)
    if (toolResult?.id) return res.json({ text: "¡Listo! Producto agregado 👍" });

    const intent = detectIntent(message || '');

    // 1) Más vendidos (con fallback robusto)
    if (intent === 'tops') {
      const items = await listTopSellers(8).then(xs => preferInStock(xs, 6));
      if (!items.length) {
        console.warn('[tops] vacío tras fallbacks');
        return res.json({ text: "Por ahora no tengo un ranking de más vendidos." });
      }
      return res.json({ text: buildProductsMarkdown(items) });
    }

    // 2) FAQs negocio (sin IA)
    if (intent === 'faq') {
      const txt = await faqAnswer(message || '');
      if (txt) return res.json({ text: txt });
      // si no hubo match, cae a IA
    }

    // 3) IA primero (info/browse)
    const ai = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: AI_POLICY },
        { role: 'user', content: message || '' }
      ]
    });
    let aiText = (ai.choices?.[0]?.message?.content || '').trim();
    if (!aiText) aiText = 'Pasos clave:\n• Prueba en zona oculta.\n• Aplica según etiqueta.\n• Retira y seca.';

    // 4) Productos: rewriter mínimo → si no, usa keywords del usuario
    let queries = smartRewrite(message || '');
    if (!queries) {
      // keywords simples
      const words = nrm(message||'').replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w=>w.length>=3);
      queries = Array.from(new Set(words)).slice(0,6);
    }

    let items = [];
    if (queries && queries.length) {
      const pool = [];
      const seen = new Set();
      for (const q of queries) {
        const found = await searchProductsPlain(q, 4);
        for (const it of found) if (!seen.has(it.handle)) { pool.push(it); seen.add(it.handle); }
        if (pool.length >= 8) break;
      }
      items = await preferInStock(pool, 3);
    }

    const list = items.length ? `\n\n${buildProductsMarkdown(items)}` : '';
    const greet = meta?.userFirstName && meta?.tipAlreadyShown !== true && FREE_TH>0 && Number(meta?.cartSubtotalCLP||0) < FREE_TH
      ? `TIP: Hola, ${meta.userFirstName} 👋 | Te faltan ${formatCLP(FREE_TH - Number(meta?.cartSubtotalCLP||0))} para envío gratis en RM\n\n`
      : '';

    return res.json({ text: `${greet}${aiText}${list}` });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});

/* ---------- Health ---------- */
app.get('/health', (_, res) => res.json({ ok: true }));

const port = PORT || process.env.PORT || 3000;
app.listen(port, () => console.log('ML Chat server on :' + port));

