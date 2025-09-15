// server.js — híbrido: IA-first + shipping/colecciones/shopping list estables
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
const stripHtml = s => String(s).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();

async function gql(query, variables = {}) {
  const url = `https://${SHOPIFY_STORE_DOMAIN}/api/${SF_API_VERSION}/graphql.json`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type':'application/json','X-Shopify-Storefront-Access-Token': SHOPIFY_STOREFRONT_TOKEN},
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

/* ----- Shipping regiones/comunas (negocio) ----- */
const REGIONES = [
  'arica y parinacota','tarapaca','antofagasta','atacama','coquimbo','valparaiso',
  'metropolitana','santiago',"o'higgins",'ohiggins','maule','nuble','biobio',
  'la araucania','araucania','los rios','los lagos','aysen','magallanes'
];
const REGIONES_F = new Set(REGIONES.map(fold));
const COMUNAS = ['las condes','vitacura','lo barnechea','providencia','ñuñoa','la reina','santiago','macul','la florida','puente alto','maipú','maipu','huechuraba','independencia','recoleta','quilicura','conchalí','conchali','san miguel','san joaquín','san joaquin','la cisterna','san bernardo','colina','buin','lampa'];
const COMUNAS_F = new Set(COMUNAS.map(fold));

const SHIPPING_ZONES = [
  { zone:'REGIÓN METROPOLITANA', cost:3990, regions:['Metropolitana','Santiago'] },
  { zone:'ZONA CENTRAL',         cost:6990, regions:['Coquimbo','Valparaíso','Valparaiso',"O’Higgins","O'Higgins",'Maule','Ñuble','Nuble','Biobío','Biobio','Araucanía','Araucania','Los Ríos','Los Rios','Los Lagos'] },
  { zone:'ZONA NORTE',           cost:10990,regions:['Arica y Parinacota','Tarapacá','Tarapaca','Antofagasta','Atacama'] },
  { zone:'ZONA AUSTRAL',         cost:14990,regions:['Aysén','Aysen','Magallanes'] }
];
const REGION_COST_MAP = (()=>{ const m=new Map(); for(const z of SHIPPING_ZONES) for(const r of z.regions) m.set(fold(r),{zone:z.zone,cost:z.cost}); m.set('metropolitana',{zone:'REGIÓN METROPOLITANA',cost:3990}); m.set('santiago',{zone:'REGIÓN METROPOLITANA',cost:3990}); return m; })();
const shippingByRegionName = (s='') => REGION_COST_MAP.get(fold(s)) || null;

/* ----- Shopping list (1 por ítem, mismo orden) ----- */
const SHOPPING_SYNONYMS = {
  'lavalozas': ['lavalozas','lava loza','lavaplatos','dishwashing','lavavajillas liquido'],
  'antigrasa': ['antigrasa','desengrasante','degreaser'],
  'multiuso':  ['multiuso','all purpose','limpiador multiuso'],
  'esponja':   ['esponja','fibra','sponge'],
  'parrillas': ['limpiador parrilla','bbq','grill','desengrasante parrilla'],
  'piso':      ['limpiador pisos','limpiador de piso','floor cleaner']
};
const tokenize = s => norm(s).replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(Boolean);
function splitShopping(text=''){
  // “necesito: lavalozas, esponja, limpiador parrillas, limpiador piso”
  const parts = String(text).split(/:|,| y /gi).slice(1).join(' ').split(/,|\by\b/gi).map(s=>s.trim()).filter(Boolean);
  if (parts.length) return parts;
  // fallback: coma o " y "
  return String(text).split(/,|\by\b/gi).map(s=>s.trim()).filter(Boolean);
}
async function bestMatchForPhrase(phrase){
  const p = phrase.toLowerCase().trim();
  const syn = SHOPPING_SYNONYMS[p] || [p];
  const pool=[]; const seen=new Set();
  for (const q of syn){
    const found = await searchProductsPlain(q, 10).catch(()=>[]);
    for (const it of found){ if(!seen.has(it.handle)){ seen.add(it.handle); pool.push(it);} }
  }
  if (!pool.length) return null;
  // prioriza stock
  return (await preferInStock(pool,1))[0] || pool[0];
}
async function selectProductsByOrderedKeywords(message){
  const parts = splitShopping(message);
  if (!parts.length) return null;
  const picks=[]; const used=new Set();
  for (const seg of parts){
    const m = await bestMatchForPhrase(seg);
    if (m && !used.has(m.handle)){ picks.push(m); used.add(m.handle); }
  }
  return picks.length ? picks : null;
}

/* ----- IA ----- */
const AI_POLICY = `
Eres el asistente de MundoLimpio.cl (Chile), experto en limpieza.
Responde PRIMERO con 3–5 bullets de pasos claros y seguros. Solo si ayuda, sugiere 1–3 tipos de producto (sin inventar marcas).
No inventes enlaces, precios ni stock. Tono cercano y breve. CTA suave al final ("¿Te sugiero 2 opciones?").
`;
const PURPOSE_REGEX = /\b(para que sirve|para qué sirve|que es|qué es|como usar|cómo usar|modo de uso|instrucciones|paso a paso|como limpiar|cómo limpiar|consejos|tips|guia|guía|pasos)\b/i;

function detectIntent(text=''){
  const q=norm(text);
  if (/(mas vendidos|más vendidos|best sellers|top ventas|lo mas vendido|lo más vendido)/.test(q)) return 'tops';
  if (PURPOSE_REGEX.test(text)) return 'info';
  if (/(envio|env[ií]o|despacho|retiro|mundopuntos|cup[oó]n|c[oó]digo de descuento|marcas|categorias|categorías)/i.test(text)) return 'faq';
  // región/comuna sola
  if (REGIONES_F.has(fold(text)) || COMUNAS_F.has(fold(text))) return 'faq';
  return 'browse';
}

function parseBrandCarouselConfig(){ try { return JSON.parse(BRAND_CAROUSEL_JSON||''); } catch { return []; } }

/* =============== Endpoint =============== */
app.post('/chat', async (req,res)=>{
  try{
    const { message, toolResult, meta={} } = req.body;
    const FREE_TH = Number(FREE_SHIPPING_THRESHOLD_CLP ?? FREE_TH_DEFAULT);

    // post-tool (cart)
    if (toolResult?.id) return res.json({ text: "¡Listo! Producto agregado 👍" });

    const intent = detectIntent(message||'');

    /* ---- Más vendidos ---- */
    if (intent === 'tops'){
      const items = await listTopSellers(8).then(xs=>preferInStock(xs,6));
      if (!items.length) return res.json({ text: "Por ahora no tengo un ranking de más vendidos." });
      return res.json({ text: buildProductsMarkdown(items) });
    }

    /* ---- FAQs negocio + shipping ---- */
    if (intent === 'faq'){
      const q = norm(message||'');
      const destinosUrl = `${BASE}/pages/destinos-disponibles-en-chile`;

      // región/comuna sola
      if (REGIONES_F.has(fold(message||''))){
        const ship = shippingByRegionName(message||'');
        const isRM = /metropolitana|santiago/.test(fold(message||''));
        const parts = [];
        if (ship) parts.push(`Para **${message}** (${ship.zone}) el costo referencial es **${fmtCLP(ship.cost)}**.`);
        else parts.push(`Para **${message}** el costo se calcula en el checkout por región/comuna.`);
        if (isRM && FREE_TH>0) parts.push(`En **RM** hay **envío gratis** sobre **${fmtCLP(FREE_TH)}** (bajo ese monto: ${fmtCLP(3990)}).`);
        parts.push(`📦 Frecuencias por zona: ${destinosUrl}`);
        return res.json({ text: parts.join(' ') });
      }
      if (COMUNAS_F.has(fold(message||''))){
        return res.json({ text: `Hacemos despacho a **todo Chile**. Para **${message}**, ingresa la **región y comuna** en el checkout y verás el costo exacto. Si me confirmas la **región**, te doy el costo referencial. 📦 ${destinosUrl}` });
      }

      if (/(envio|env[ií]o|despacho|retiro)/.test(q)){
        const header = FREE_TH>0 ? `En **RM** hay **envío gratis** sobre **${fmtCLP(FREE_TH)}**.` : `Hacemos despacho a **todo Chile**.`;
        const body = `El costo se calcula automáticamente en el **checkout** según **región y comuna**. ¿Me indicas tu región y comuna?`;
        const tarifas =
          `Tarifas referenciales por región:\n- **RM**: ${fmtCLP(3990)}\n- **Zona Central**: ${fmtCLP(6990)}\n- **Zona Norte**: ${fmtCLP(10990)}\n- **Zona Austral**: ${fmtCLP(14990)}`;
        return res.json({ text: [header, body, `Frecuencias: ${destinosUrl}`, '', tarifas].join('\n') });
      }

      if (/(cupon|cup[oó]n|c[oó]digo de descuento|codigo de descuento)/.test(q)){
        return res.json({ text: `En el **checkout** verás el campo “Código de descuento o tarjeta de regalo”. Pega tu cupón y presiona **Aplicar**.` });
      }

      if (/mundopuntos|puntos|fidelizaci[óo]n/.test(q)){
        const earn = Number(MUNDOPUNTOS_EARN_PER_CLP || 1);
        const redeem100 = Number(MUNDOPUNTOS_REDEEM_PER_100 || 3);
        const url = (MUNDOPUNTOS_PAGE_URL || '').trim();
        return res.json({ text: `**Mundopuntos**: ganas **${earn} punto(s) por $1**. Canje: **100 puntos = ${fmtCLP(redeem100)}**. ${url?`Más info: ${url}`:'Adminístralo en el widget de recompensas.'}` });
      }

      if (/(que|qué)\s+marcas/.test(q)){
        const custom = parseBrandCarouselConfig();
        if (custom.length){
          const lines = custom.map(b=>[b.title,b.url,b.image||''].join('|')).join('\n');
          return res.json({ text: `BRANDS:\n${lines}` });
        }
        return res.json({ text: 'Trabajamos varias marcas internacionales y locales. ¿Cuál te interesa?' });
      }

      if (/(categorias|categorías|tipos de productos|colecciones)/.test(q)){
        // listar colecciones reales como chips
        const cols = await listCollections(8);
        if (!cols.length) return res.json({ text: 'Tenemos limpieza de cocina, baño, pisos, lavandería, superficies y accesorios.' });
        const payload = cols.map(c=>`${c.title}|${BASE}/collections/${c.handle}`).join('\n');
        return res.json({ text: `CATS:\n${payload}` });
      }
      // si no hubo match claro, seguimos a IA
    }

    /* ---- IA primero (info/browse) ---- */
    const ai = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: AI_POLICY },
        { role: 'user', content: message || '' }
      ]
    });
    let aiText = (ai.choices?.[0]?.message?.content || '').trim();
    if (!aiText) aiText = 'Pasos clave:\n• Prueba en zona oculta.\n• Aplica según etiqueta.\n• Retira y seca.';

    // Shopping list (si pide varios):
    const shoppingPicks = await selectProductsByOrderedKeywords(message||'');
    if (shoppingPicks && shoppingPicks.length){
      const text = `Te dejo una opción por ítem:\n\n${buildProductsMarkdown(shoppingPicks)}`;
      return res.json({ text });
    }

    // Productos sugeridos (ligero): usa palabras del usuario, con un poco de “rewriter” simple
    let queries = null;
    const qn = norm(message||'');
    if (/\bpapeles?\b/.test(qn)) queries = ['papel higienico','toalla de papel','servilletas'];
    else if (/(parrilla|bbq|grill)/.test(qn)) queries = ['limpiador parrilla','desengrasante parrilla','goo gone bbq'];
    else {
      const words = qn.replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w=>w.length>=3);
      queries = Array.from(new Set(words)).slice(0,6);
    }

    let items = [];
    if (queries.length){
      const pool=[]; const seen=new Set();
      for (const q of queries){
        const found = await searchProductsPlain(q, 5);
        for (const it of found) if (!seen.has(it.handle)){ seen.add(it.handle); pool.push(it); }
        if (pool.length >= 10) break;
      }
      items = await preferInStock(pool, 3);
    }

    const list = items.length ? `\n\n${buildProductsMarkdown(items)}` : '';
    return res.json({ text: `${aiText}${list}` });

  }catch(e){
    console.error(e);
    return res.status(500).json({ error: String(e) });
  }
});

/* ---- Health ---- */
app.get('/health', (_,res)=>res.json({ ok:true }));
const port = PORT || process.env.PORT || 3000;
app.listen(port, ()=>console.log('ML Chat server on :'+port));

