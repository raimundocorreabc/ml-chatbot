// server.js — IA-first + categorías/brands/envíos/regiones/shopping-list sólidos
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
  // Chips de regiones (para que el front lo muestre como carrusel y haga “envío <región>” al click)
  const uniq = Array.from(new Set(REGIONES_LIST.map(r=>r.replace(/\"/g,''))));
  // Formato: "Titulo|ValorAlClick"
  return uniq.map(r => `${r}|${r}`).join('\n');
}

/* ----- Shopping list (1 por ítem, mismo orden) ----- */
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
  'protector textil': ['protector textil','impermeabilizante telas','fabric protector']
};
const tokenize = s => norm(s).replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(Boolean);

function splitShopping(text=''){
  // Acepta: "necesito: lavalozas, esponja, limpiador de parrilla y limpiador de alfombra"
  const afterColon = text.split(':');
  const base = afterColon.length > 1 ? afterColon.slice(1).join(':') : text;
  return base.split(/,|\by\b/gi).map(s=>s.trim()).filter(Boolean);
}

async function bestMatchForPhrase(phrase){
  const p = phrase.toLowerCase().trim();
  // mapear a sinónimos si exacto
  const syn = SHOPPING_SYNONYMS[p] || [p];
  const pool=[]; const seen=new Set();
  for (const q of syn){
    const found = await searchProductsPlain(q, 10).catch(()=>[]);
    for (const it of found){ if(!seen.has(it.handle)){ seen.add(it.handle); pool.push(it);} }
  }
  if (!pool.length) {
    // fallback: usa tokens relevantes del texto
    const tokens = tokenize(phrase).filter(t=>t.length>=3).slice(0,3);
    for(const t of tokens){
      const found = await searchProductsPlain(t, 6).catch(()=>[]);
      for (const it of found){ if(!seen.has(it.handle)){ seen.add(it.handle); pool.push(it);} }
    }
  }
  if (!pool.length) return null;
  return (await preferInStock(pool,1))[0] || pool[0];
}

async function selectProductsByOrderedKeywords(message){
  const parts = splitShopping(message);
  if (parts.length < 2) return null; // solo disparar este flujo cuando pidió varios
  const picks=[]; const used=new Set();
  for (const seg of parts){
    const m = await bestMatchForPhrase(seg);
    if (m && !used.has(m.handle)){ picks.push(m); used.add(m.handle); }
  }
  return picks.length ? picks : null;
}

/* ----- Búsqueda precisa por título (mejora de relevancia) ----- */
function extractKeywords(text='', max=8){
  const tokens = tokenize(text).filter(t => t.length>=3);
  const stop = new Set(['tienen','venden','quiero','necesito','precio','productos','producto','limpieza','limpiar','ayuda','me','puedes','recomendar']);
  const bag=[]; const seen=new Set();
  for (const t of tokens){
    if (stop.has(t)) continue;
    const base = t.replace(/s$/,'');
    if (seen.has(base)) continue;
    seen.add(base); bag.push(base);
    if (bag.length>=max) break;
  }
  return bag;
}
async function titleMatchProducts(queryText, max=6){
  const pool = await searchProductsPlain(String(queryText||'').slice(0,120), 24);
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
  const ordered = await preferInStock(shortlist, max);
  return ordered;
}

/* ----- IA ----- */
const AI_POLICY = `
Eres el asistente de MundoLimpio.cl (Chile), experto en limpieza.
Siempre responde PRIMERO con 3–5 bullets (pasos claros y seguros).
Luego, si suma valor, sugiere tipos de producto (1–3), sin inventar marcas ni precios.
Tono cercano, breve, con CTA suave ("¿Te sugiero 2 opciones?").
No inventes enlaces ni stock. No repitas consejos obvios.
`;

const PURPOSE_REGEX = /\b(para que sirve|para qué sirve|que es|qué es|como usar|cómo usar|modo de uso|instrucciones|paso a paso|como limpiar|cómo limpiar|consejos|tips|guia|guía|pasos)\b/i;

/* === CAMBIO APLICADO: priorizar "envío <región/comuna>" === */
function detectIntent(text=''){
  const q = norm(text);

  // Si viene "envío <lugar>", intenta rutear directo a shipping_region
  const m = String(text||'').match(/^env[ií]o\s+(.+)$/i);
  if (m) {
    const loc = fold(m[1]);
    if (REGIONES_F.has(loc) || COMUNAS_F.has(loc)) return 'shipping_region';
  }

  if (REGIONES_F.has(fold(text)) || COMUNAS_F.has(fold(text))) return 'shipping_region';
  if (/(mas vendidos|más vendidos|best sellers|top ventas|lo mas vendido|lo más vendido)/.test(q)) return 'tops';
  if (/(envio|env[ií]o|despacho|retiro)/.test(q)) return 'shipping';
  if (/(mundopuntos|puntos|fidelizaci[óo]n)/.test(q)) return 'points';
  if (/(que marcas|qué marcas|marcas venden|marcas disponibles)/.test(q)) return 'brands';
  if (/(categorias|categorías|tipos de productos|colecciones|que productos venden|qué productos venden)/.test(q)) return 'categories';
  if (PURPOSE_REGEX.test(text)) return 'info';
  // shopping-list si trae comas o "necesito:"
  if (/,/.test(text) || /necesito:|lista:|comprar:|quiero:/.test(q)) return 'shopping';
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
      // generar desde vendors
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
      // fallback: chips hacia búsqueda por palabras (sin inventar handles)
      const fallback = [
        ['LIMPIEZA Y ASEO', `${BASE}/search?q=limpieza`],
        ['LAVADO DE ROPA',  `${BASE}/search?q=ropa`],
        ['CUIDADO PERSONAL',`${BASE}/search?q=personal`],
        ['COCINA',          `${BASE}/search?q=cocina`],
        ['BAÑO',            `${BASE}/search?q=ba%C3%B1o`],
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
      // si no hubo match, caemos a browse+IA
    }

    /* ---- IA para info (paso a paso) + sugerencias concretas ---- */
    if (intent === 'info' || intent === 'browse'){
      // 1) Mini plan con IA (bloque TIP:)
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

      // 2) Recomendaciones de productos (precisas)
      let items = [];

      // mapeos útiles (mejor precisión)
      const qn = norm(message||'');
      if (/(impermeabiliz|protector).*(sillon|sof[aá]|tapiz)/.test(qn)) {
        items = await searchProductsPlain('protector textil', 12).then(xs=>preferInStock(xs,3));
      } else if (/(olla).*(quemad)/.test(qn)) {
        const pool = [];
        for (const q of ['pink stuff pasta','desengrasante cocina','limpieza acero inox']){
          const found = await searchProductsPlain(q, 6); pool.push(...found);
        }
        items = await preferInStock(pool,3);
      } else if (/(mesa|vidrio).*(limpiar|mancha|grasa|sarro)/.test(qn) || /limpia\s*vidri/.test(qn)) {
        items = await searchProductsPlain('limpia vidrios', 10).then(xs=>preferInStock(xs,3));
      } else if (/(lavalozas|lava loza|lavaplatos)/.test(qn)) {
        items = await searchProductsPlain('lavalozas', 12).then(xs=>preferInStock(xs,6));
      } else if (/(parrilla|bbq|grill)/.test(qn)) {
        const pool = [];
        for (const q of ['limpiador parrilla','goo gone bbq','desengrasante parrilla']) {
          const found = await searchProductsPlain(q, 6); pool.push(...found);
        }
        items = await preferInStock(pool,6);
      } else {
        // scoring por título + stock
        items = await titleMatchProducts(message||'', 6);
      }

      const list = items.length ? `\n\n${buildProductsMarkdown(items)}` : '';
      const greet = (meta?.userFirstName && meta?.tipAlreadyShown!==true && Number(meta?.cartSubtotalCLP||0) < Number(FREE_TH||FREE_TH_DEFAULT))
        ? `TIP: Hola, ${meta.userFirstName} 👋 | Te faltan ${fmtCLP(Number(FREE_TH||FREE_TH_DEFAULT) - Number(meta?.cartSubtotalCLP||0))} para envío gratis en RM\n\n`
        : '';

      // si no hay IA, al menos devolvemos productos
      const finalText = (tipText ? `${greet}${tipText}${list}` : (list || 'No encontré coincidencias exactas. ¿Me das una pista más (marca, superficie, aroma)?'));
      return res.json({ text: finalText });
    }

    // Fallback total
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
