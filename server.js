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
  SHOPIFY_API_VERSION,           // <— nuevo (opcional), por defecto 2024-10
  PORT,

  FREE_SHIPPING_THRESHOLD_CLP,
  MUNDOPUNTOS_EARN_PER_CLP,
  MUNDOPUNTOS_REDEEM_PER_100,
  MUNDOPUNTOS_PAGE_URL,
  BRAND_CAROUSEL_JSON
} = process.env;

if (!OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY");
if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_STOREFRONT_TOKEN) throw new Error("Falta SHOPIFY_STORE_DOMAIN o SHOPIFY_STOREFRONT_TOKEN");
if (!SHOPIFY_PUBLIC_STORE_DOMAIN) throw new Error("Falta SHOPIFY_PUBLIC_STORE_DOMAIN");

const app = express();
app.use(express.json());

/* -------- CORS: permite por defecto el dominio público del shop -------- */
const normalizeOrigin = (u) => {
  try { return new URL(u).origin; } catch { return (u || '').replace(/\/+$/, ''); }
};
const defaultAllowed = (() => {
  try {
    const o = normalizeOrigin(SHOPIFY_PUBLIC_STORE_DOMAIN);
    // agrega ambas variantes por si acaso
    if (/^https?:\/\/www\./i.test(o)) {
      return [o, o.replace('//www.', '//')];
    } else {
      return [o, o.replace('://', '://www.')];
    }
  } catch { return []; }
})();
const allowedList = (ALLOWED_ORIGINS && ALLOWED_ORIGINS.trim()
  ? ALLOWED_ORIGINS.split(',').map(s => normalizeOrigin(s.trim()))
  : defaultAllowed
).filter(Boolean);
const allowAll = allowedList.length === 0;

app.use(cors({
  origin: (origin, cb) => {
    if (allowAll) return cb(null, true);
    if (!origin)  return cb(null, true); // health checks, curl, etc.
    const ok = allowedList.includes(normalizeOrigin(origin));
    return ok ? cb(null, true) : cb(new Error('Origen no permitido: ' + origin));
  },
  credentials: true
}));

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ---------------- Utils ---------------- */
const BASE = normalizeOrigin(SHOPIFY_PUBLIC_STORE_DOMAIN);
const FREE_TH_DEFAULT = 40000; // RM ≥ $40.000
const SF_API_VERSION = (SHOPIFY_API_VERSION && SHOPIFY_API_VERSION.trim()) || '2024-10'; // ✅ estable

const fmt = (n) => new Intl.NumberFormat('es-CL', { style:'currency', currency:'CLP', maximumFractionDigits:0 }).format(Math.round(Number(n)||0));
const norm = (s='') => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const fold = (s='') => norm(s).replace(/ñ/g,'n');

/* ---------------- Regiones/comunas + shipping ---------------- */
const REGIONES = [
  'arica y parinacota','tarapaca','antofagasta','atacama','coquimbo','valparaiso',
  'metropolitana','santiago',"o'higgins",'ohiggins','maule','nuble','biobio',
  'la araucania','araucania','los rios','los lagos','aysen','magallanes'
];
const REGIONES_FOLDED = REGIONES.map(fold);

const COMUNAS_RM = [
  'las condes','vitacura','lo barnechea','providencia','ñuñoa','la reina','peñalolén','santiago',
  'macul','la florida','puente alto','maipú','huechuraba','independencia','recoleta','quilicura',
  'conchalí','san miguel','san joaquín','la cisterna','san bernardo','colina','buin','lampa'
];
const COMUNAS_RM_FOLDED = COMUNAS_RM.map(fold);
const COMUNA_REGION_MAP = new Map(COMUNAS_RM_FOLDED.map(c => [c, 'metropolitana']));

const SHIPPING_ZONES = [
  { zone: 'REGIÓN METROPOLITANA', cost: 3990,  regions: ['Metropolitana','Santiago'] },
  { zone: 'ZONA CENTRAL',         cost: 6990,  regions: ['Coquimbo','Valparaíso','Valparaiso',"O’Higgins","O'Higgins",'Maule','Ñuble','Nuble','Biobío','Biobio','Araucanía','Araucania','Los Ríos','Los Rios','Los Lagos'] },
  { zone: 'ZONA NORTE',           cost: 10990, regions: ['Arica y Parinacota','Tarapacá','Tarapaca','Antofagasta','Atacama'] },
  { zone: 'ZONA AUSTRAL',         cost: 14990, regions: ['Aysén','Aysen','Magallanes'] }
];
const REGION_COST = (() => {
  const m = new Map();
  for (const z of SHIPPING_ZONES) for (const r of z.regions) m.set(fold(r), { zone: z.zone, cost: z.cost });
  m.set('metropolitana', { zone: 'REGIÓN METROPOLITANA', cost: 3990 });
  m.set('santiago',      { zone: 'REGIÓN METROPOLITANA', cost: 3990 });
  return m;
})();

function findRegionIn(s='') {
  const f = ' ' + fold(s) + ' ';
  if (/\brm\b/.test(f)) return 'metropolitana';
  if (f.includes(' region metropolitana ')) return 'metropolitana';
  if (f.includes(' santiago ')) return 'metropolitana';
  for (const r of REGIONES_FOLDED) if (f.includes(' ' + r + ' ')) return r;
  return null;
}
function findComunaIn(s='') {
  const f = ' ' + fold(s) + ' ';
  for (const c of COMUNAS_RM_FOLDED) if (f.includes(' ' + c + ' ')) return c;
  return null;
}

/* ---------------- Shopify utils ---------------- */
async function sf(query, variables = {}) {
  const url = `https://${SHOPIFY_STORE_DOMAIN}/api/${SF_API_VERSION}/graphql.json`; // ✅ versión estable
  const r = await fetch(url, {
    method:'POST',
    headers:{
      'Content-Type':'application/json',
      'X-Shopify-Storefront-Access-Token': SHOPIFY_STOREFRONT_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  if (!r.ok) {
    const txt = await r.text().catch(()=>String(r.status));
    throw new Error('Storefront API ' + r.status + ' ' + txt);
  }
  const data = await r.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data.data;
}
const getProductJsonByHandle = async (h) => (await (await fetch(`${BASE}/products/${h}.js`)).json());
const getProductDetailsByHandle = async (h) => (await sf(`
  query($h:String!){ product(handle:$h){ title handle description } }
`,{h})).product || null;

/* ---------------- Búsquedas ---------------- */
async function searchProductsPlain(q, n=5){
  const d = await sf(`
    query($q:String!,$n:Int!){
      search(query:$q, types: PRODUCT, first:$n){
        edges{ node{ ... on Product{ title handle } } }
      }
    }
  `, { q, n });
  return (d.search?.edges || []).map(e => ({ title:e.node.title, handle:e.node.handle }));
}
async function listTopSellers(n=5){
  const d = await sf(`query($n:Int!){ products(first:$n, sortKey:BEST_SELLING){ edges{ node{ title handle } } } }`,{n});
  return (d.products?.edges || []).map(e => ({ title:e.node.title, handle:e.node.handle }));
}
async function searchByVendor(vendor, n=5){
  const d = await sf(`query($q:String!,$n:Int!){ products(first:$n, query:$q){ edges{ node{ title handle vendor } } } }`, { q:`vendor:"${vendor}"`, n });
  return (d.products?.edges || []).map(e => ({ title:e.node.title, handle:e.node.handle }));
}
async function listVendors(limit=20){
  const d = await sf(`query{ products(first:100){ edges{ node{ vendor } } } }`);
  const vendors = (d.products?.edges||[]).map(e => (e.node.vendor||'').trim()).filter(Boolean);
  const freq = new Map(); for(const v of vendors) freq.set(v,(freq.get(v)||0)+1);
  return [...freq.entries()].sort((a,b)=>b[1]-a[1]).map(([v])=>v).slice(0,limit);
}
async function listCollections(limit=10){
  const d = await sf(`query($n:Int!){ collections(first:$n){ edges{ node{ title handle } } } }`,{n:limit});
  return (d.collections?.edges||[]).map(e=>({title:e.node.title, handle:e.node.handle}));
}
async function searchMulti(queries=[], max=5){
  const picks=[]; const seen=new Set();
  for(const q of queries){
    const found = await searchProductsPlain(q,3);
    for(const it of found){
      if(!seen.has(it.handle)){ seen.add(it.handle); picks.push(it); if(picks.length>=max) return picks; }
    }
  }
  return picks;
}
async function recommendZoneProducts(zones=[]){
  const queries={
    'baño':['antihongos baño','astonish baño 750','limpiador baño'],
    'cocina':['desengrasante cocina','cif crema','astonish kitchen'],
    'horno':['astonish horno','goo gone bbq','weiman cook top']
  };
  const picks=[]; const seen=new Set();
  for(const z of zones){
    for(const q of (queries[z]||[])){
      const it = (await searchProductsPlain(q,2)).find(i=>!seen.has(i.handle));
      if(it){ picks.push(it); seen.add(it.handle); break; }
    }
  }
  return picks;
}

/* ---------------- IA tools ---------------- */
const tools = [
  { type:'function', function:{ name:'searchProducts', description:'Busca productos por texto', parameters:{ type:'object', properties:{ query:{type:'string'} }, required:['query'] } } },
  { type:'function', function:{ name:'getVariantByOptions', description:'Devuelve variantId numérico para /cart/add.js', parameters:{ type:'object', properties:{ handle:{type:'string'}, options:{type:'object', additionalProperties:{type:'string'}} }, required:['handle'] } } },
  { type:'function', function:{ name:'addToCartClient', description:'Pide al navegador /cart/add.js', parameters:{ type:'object', properties:{ variantId:{type:'string'}, quantity:{type:'number',default:1} }, required:['variantId'] } } }
];

/* ---------------- Texto helpers ---------------- */
const buildProductsMarkdown = (items=[]) => items.length
  ? `Aquí tienes opciones:\n\n${items.map((p,i)=>`${i+1}. **[${(p.title||'Ver producto').replace(/\*/g,'')}](${BASE}/products/${p.handle})** – agrega al carrito o ver más detalles.`).join('\n')}`
  : null;

const stripAndTrim = (s='') => String(s).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();

/* TIP saludo (una sola vez, solo si hay subtotal>0) */
function maybePrependGreetingTip(text, meta, FREE_TH){
  const name = (meta?.userFirstName||'').trim();
  const already = !!meta?.tipAlreadyShown;
  if (!name || already) return text;
  const sub = Number(meta?.cartSubtotalCLP||0);
  const extra = (Number.isFinite(sub) && sub>0 && FREE_TH>0 && sub<FREE_TH) ? ` | Te faltan ${fmt(FREE_TH - sub)} para envío gratis en RM` : '';
  return `TIP: Hola, ${name} 👋${extra}\n\n${text}`;
}

/* Carrusel de marcas */
const parseBrands = () => { try { return JSON.parse(BRAND_CAROUSEL_JSON||''); } catch { return []; } };
const buildBrandsPayload = (arr=[]) => {
  const rows = arr.map(b=>{
    const title=(b.title||'').trim(), url=(b.url||'').trim(), image=(b.image||'').trim();
    return (title && url) ? [title,url,image].join('|') : null;
  }).filter(Boolean);
  return rows.length ? `BRANDS:\n${rows.join('\n')}` : null;
};

/* ---------------- Tips compactos + productos ---------------- */
async function tipVitro(){ const t=['Vitrocerámica — pasos rápidos:','1) Rasqueta plástica en frío.','2) Crema específica 1–2 min.','3) Microfibra; repite manchas.','4) Opcional: protector.'].join('\n'); const list=buildProductsMarkdown(await searchMulti(['weiman vitroceramica crema','weiman cook top kit','astonish vitroceramica'],3)); return list?`TIP: ${t}\n\n${list}`:`TIP: ${t}`; }
async function tipAlfombra(){ const t=['Alfombra — limpieza básica:','1) Aspira a fondo.','2) Prueba en zona oculta.','3) Limpiador de alfombras + cepillo suave.','4) Ventila hasta secar.'].join('\n'); const list=buildProductsMarkdown(await searchMulti(['alfombra limpiador','tapicerias astonish','protector textil'],3)); return list?`TIP: ${t}\n\n${list}`:`TIP: ${t}`; }
async function tipCortina(){ const t=['Cortina tela — cuidado rápido:','1) Aspira polvo.','2) Trata manchas puntuales.','3) Lava según etiqueta o seco.','4) Opción: protector textil.'].join('\n'); const list=buildProductsMarkdown(await searchMulti(['quitamanchas tela','protector textil','limpiador telas'],3)); return list?`TIP: ${t}\n\n${list}`:`TIP: ${t}`; }
async function tipOlla(){ const t=['Olla quemada — cómo salvarla:','1) Agua + bicarbonato (o vinagre).','2) Hervir 5 min y enfriar.','3) Pasta desengrasante.','4) Acero inox: limpiador específico.'].join('\n'); const list=buildProductsMarkdown(await searchMulti(['pink stuff pasta 850','astonish vitroceramica kit','weiman acero inoxidable 710'],3)); return list?`TIP: ${t}\n\n${list}`:`TIP: ${t}`; }
async function tipSillon(){ const t=['Sillón/tapiz — rutina corta:','1) Aspira bien.','2) Prueba en zona oculta.','3) Limpiador de telas + microfibra.','4) Opción: protector anti manchas.'].join('\n'); const list=buildProductsMarkdown(await searchMulti(['limpiador tela sofa','protector textil','quitamanchas tapiz'],3)); return list?`TIP: ${t}\n\n${list}`:`TIP: ${t}`; }

/* ---------------- Intent ---------------- */
function detectIntent(text=''){
  const f = fold((text||'').trim());
  const mentionsRegion = !!findRegionIn(text);
  const mentionsComuna = !!findComunaIn(text);

  const infoTriggers = [
    'para que sirve','como usar','instrucciones','modo de uso','ingredientes','composicion',
    'sirve para','usos','beneficios','caracteristicas','como puedo','como sacar','como limpiar',
    'consejos','tips','que es','envio','despacho','retiro','gratis','costo de envio','envio gratis',
    'mundopuntos','puntos','fidelizacion','checkout','cupon','codigo de descuento',
    'marcas venden','tipos de productos','que productos venden','que venden'
  ];
  const buyTriggers = ['comprar','agrega','agregar','añade','añadir','carrito','precio','recomiend'];

  if (mentionsRegion || mentionsComuna) return 'info';
  if (infoTriggers.some(t => f.includes(t))) return 'info';
  if (buyTriggers.some(t => f.includes(t))) return 'buy';
  return 'browse';
}

/* ---------------- FAQ/envíos ---------------- */
function shippingInfoBlock(FREE_TH){
  const header = FREE_TH>0
    ? `En la **Región Metropolitana (RM)** ofrecemos **envío gratis** en compras sobre **${fmt(FREE_TH)}**.`
    : `Hacemos despacho a **todo Chile**.`;
  const p2 = `Para pedidos bajo ese monto en la RM, y para **todas las regiones**, el costo se calcula automáticamente en el **checkout** según la **región y comuna** de destino.`;
  const p3 = `Si me indicas tu **región** y **comuna**, puedo confirmarte el **costo** y la **frecuencia de entrega** en tu zona.`;
  const p4 = `📦 Frecuencias de entrega: ${BASE}/pages/destinos-disponibles-en-chile`;
  const tarifas =
    `Tarifas referenciales por región:\n` +
    `- **RM**: ${fmt(3990)}\n` +
    `- **Zona Central**: ${fmt(6990)}\n` +
    `- **Zona Norte**: ${fmt(10990)}\n` +
    `- **Zona Austral**: ${fmt(14990)}`;
  return [header,'',p2,'',p3,p4,'',tarifas].join('\n');
}

async function faqAnswerOrNull(message='', meta={}){
  const raw = (message||'').trim();

  // Prefijo "envío ..."
  const mPref = raw.match(/^(env[ií]o|envio|despacho|retiro)\s+(.+)$/i);
  const query = mPref ? mPref[2] : raw;

  const FREE_TH = Number(FREE_SHIPPING_THRESHOLD_CLP ?? FREE_TH_DEFAULT);

  const regionFound = findRegionIn(query);
  const comunaFound = findComunaIn(query);
  const regionFromComuna = comunaFound ? COMUNA_REGION_MAP.get(comunaFound) : null;
  const regionKey = regionFound || regionFromComuna || null;

  if (regionKey && comunaFound) {
    const info = REGION_COST.get(regionKey);
    const comunaNice = COMUNAS_RM.find(c => fold(c)===comunaFound) || comunaFound;
    const regNice = REGIONES.find(r => fold(r)===regionKey) || regionKey;
    const parts = [];
    if (info) parts.push(`Para **${comunaNice}** (Región **${regNice}**), el costo referencial es **${fmt(info.cost)}**.`);
    else parts.push(`Hacemos despacho a **todo Chile**. El costo se calcula en el checkout según **región/comuna** y peso.`);
    if (regionKey==='metropolitana' && FREE_TH>0) parts.push(`En **RM** hay **envío gratis** sobre **${fmt(FREE_TH)}**.`);
    parts.push(`📦 Frecuencias: ${BASE}/pages/destinos-disponibles-en-chile`);
    return parts.join(' ');
  }

  if (regionKey && !comunaFound) {
    const regNice = REGIONES.find(r => fold(r)===regionKey) || regionKey;
    const info = REGION_COST.get(regionKey);
    const parts = [];
    if (info) parts.push(`Para **${regNice}** (${info.zone}), el costo referencial es **${fmt(info.cost)}**.`);
    else parts.push(`Para **${regNice}**, el costo se calcula en el checkout según **región/comuna** y peso.`);
    if (regionKey==='metropolitana' && FREE_TH>0) parts.push(`En **RM** ofrecemos **envío gratis** sobre **${fmt(FREE_TH)}**.`);
    parts.push(`Si me dices la **comuna**, te confirmo frecuencia.`);
    parts.push(`📦 Frecuencias: ${BASE}/pages/destinos-disponibles-en-chile`);
    return parts.join(' ');
  }

  if (!regionKey && comunaFound) {
    const comunaNice = COMUNAS_RM.find(c => fold(c)===comunaFound) || comunaFound;
    const info = REGION_COST.get('metropolitana');
    const parts = [
      `Para **${comunaNice}** (Región **Metropolitana**), el costo referencial es **${fmt(info.cost)}**.`,
      FREE_TH>0 ? `En **RM** hay **envío gratis** sobre **${fmt(FREE_TH)}**.` : '',
      `📦 Frecuencias: ${BASE}/pages/destinos-disponibles-en-chile`
    ].filter(Boolean);
    return parts.join(' ');
  }

  if (/(env[ií]o|envio|despacho|retiro|gratis|minimo|m[ií]nimo)/i.test(raw)) {
    return shippingInfoBlock(FREE_TH);
  }

  if (/(donde|en que parte|cómo|como).*(checkout|pago|carro|carrito).*(cupon|cup[oó]n|c[oó]digo de descuento|codigo de descuento)/i.test(raw)) {
    return `En el **checkout** verás el campo **“Código de descuento o tarjeta de regalo”**. Pega tu cupón y presiona **Aplicar**. Si es un cupón de **Mundopuntos**, primero géneralo en el **widget de recompensas** y luego cópialo ahí.`;
  }

  if (/(que es|qué es|quienes son|quiénes son).*(mundolimpio|mundo limpio)|que venden en mundolimpio|que productos venden\??$/i.test(raw)) {
    const cols = await listCollections(8);
    if (!cols.length) return `**MundoLimpio.cl** es una tienda chilena de limpieza/hogar premium.`;
    const payload = cols.map(c => `${c.title}|${BASE}/collections/${c.handle}`).join('\n');
    return `CATS:\n${payload}`;
  }

  if (/(que|qué)\s+marcas.*venden|marcas\s*(disponibles|que tienen|venden)/i.test(raw)) {
    const custom = parseBrands();
    if (custom.length) {
      const payload = buildBrandsPayload(custom);
      if (payload) return payload;
    }
    const vendors = await listVendors(20);
    if (!vendors.length) return 'Trabajamos varias marcas internacionales y locales. ¿Cuál te interesa?';
    const brands = vendors.map(v => ({ title:v, url:`${BASE}/collections/vendors?q=${encodeURIComponent(v)}`, image:'' }));
    const payload = buildBrandsPayload(brands);
    return payload || `Trabajamos marcas como: **${vendors.join('**, **')}**. ¿Buscas alguna en particular?`;
  }

  if ((/(que|qué)\s+tipos\s+de\s+productos\s+venden|categor[ií]as|secciones|colecciones/i).test(raw)) {
    const cols = await listCollections(10);
    if (!cols.length) return 'Tenemos múltiples categorías: cocina, baño, pisos, lavandería, superficies, accesorios y más.';
    const payload = cols.map(c => `${c.title}|${BASE}/collections/${c.handle}`).join('\n');
    return `CATS:\n${payload}`;
  }

  if (/vitrocer[aá]mica|vitro\s*cer[aá]mica/i.test(raw)) return await tipVitro();
  if (/alfombra(s)?/i.test(raw)) return await tipAlfombra();
  if (/cortina(s)?/i.test(raw)) return await tipCortina();
  if (/olla.*quemad/i.test(raw)) return await tipOlla();
  if (/sill[oó]n|sofa|sof[aá]|tapiz/i.test(raw)) return await tipSillon();

  if (/mundopuntos|puntos|fidelizaci[óo]n/i.test(raw)) {
    const earn = Number(MUNDOPUNTOS_EARN_PER_CLP || 1);
    const redeem100 = Number(MUNDOPUNTOS_REDEEM_PER_100 || 3);
    const url = (MUNDOPUNTOS_PAGE_URL || '').trim();
    return [
      `**Mundopuntos**: ganas **${earn} punto(s) por cada $1** que gastes.`,
      `El canje es **100 puntos = ${fmt(redeem100)}**.`,
      `Puedes canjear en el **checkout** ingresando tu cupón.`,
      url ? `Más info: ${url}` : `También puedes ver y canjear tus puntos en el **widget de recompensas**.`
    ].join(' ');
  }

  if (/(hongo|moho).*(baño|ducha|tina)|sacar los hongos|sacar hongos/i.test(raw)) {
    const list = buildProductsMarkdown(await searchMulti(['antihongos baño','antihongos interior','moho ducha'],3));
    const tip = ['Baño con hongos — rápido:','1) Ventila y usa guantes.','2) Aplica antihongos 5–10 min.','3) Cepilla, enjuaga y seca.'].join('\n');
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

    if (intent === 'info') {
      const faq = await faqAnswerOrNull(message || '', meta);
      if (faq) return res.json({ text: maybePrependGreetingTip(faq, meta, FREE_TH) });

      const d = await sf(
        `query($q:String!){ search(query:$q, types:PRODUCT, first:1){ edges{ node{ ... on Product{ title handle } } } } }`,
        { q: String(message||'').slice(0,120) }
      );
      const node = d?.search?.edges?.[0]?.node;
      if (node?.handle) {
        const detail = await getProductDetailsByHandle(node.handle);
        const desc = stripAndTrim(detail?.description || '');
        const resumen = desc ? (desc.length>300 ? desc.slice(0,300)+'…' : desc)
                             : 'Es un limpiador multiusos para remover suciedad difícil en superficies compatibles.';
        let text = `INFO: ${(detail?.title || node.title || 'Producto').trim()}\n${resumen}\nURL: ${BASE}/products/${node.handle}`;
        text = maybePrependGreetingTip(text, meta, FREE_TH);
        return res.json({ text });
      }

      const ai = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: [
              'Eres un experto en limpieza para Chile.',
              'Responde en español (Chile), tono cercano y claro.',
              'Da pasos breves y prácticos (máx 5 bullets).',
              'NO inventes enlaces, precios ni productos específicos.',
              userFirstName ? `Usa el nombre del usuario si cabe: ${userFirstName}.` : ''
            ].filter(Boolean).join(' ')
          },
          { role: 'user', content: message || '' }
        ]
      });
      return res.json({ text: maybePrependGreetingTip(ai.choices[0].message.content, meta, FREE_TH) });
    }

    const f = fold(message||'');
    if (/(mas vendidos|más vendidos|best sellers|top ventas|lo mas vendido|lo más vendido)/.test(f)) {
      const items = await listTopSellers(5);
      let text = buildProductsMarkdown(items) || "Por ahora no tengo un ranking de más vendidos.";
      text = maybePrependGreetingTip(text, meta, FREE_TH);
      return res.json({ text });
    }

    const mBrand = (message||'').toLowerCase().match(/tienen la marca\s+([a-z0-9&\-\s]+)/i) || (message||'').toLowerCase().match(/tienen\s+([a-z0-9&\-\s]+)\??$/i);
    if (mBrand) {
      const brand = mBrand[1].trim();
      if (brand.length>=2 && brand.length<=40) {
        const items = await searchByVendor(brand, 5);
        if (items.length) return res.json({ text: maybePrependGreetingTip(buildProductsMarkdown(items), meta, FREE_TH) });
        const fallback = await searchProductsPlain(brand, 5);
        if (fallback.length) return res.json({ text: maybePrependGreetingTip(buildProductsMarkdown(fallback), meta, FREE_TH) });
        return res.json({ text: `Sí trabajamos varias marcas. No encontré resultados exactos para "${brand}". ¿Quieres alternativas similares?` });
      }
    }

    if (/pasta.*(rosada|pink)|pink.*stuff/i.test(f)) {
      const items = await searchProductsPlain('pink stuff pasta multiuso stardrops',5);
      if (items.length) return res.json({ text: maybePrependGreetingTip(buildProductsMarkdown(items), meta, FREE_TH) });
    }
    if (/pasta.*(original|astonish)|astonish.*pasta/i.test(f)) {
      const items = await searchProductsPlain('astonish pasta original multiuso',5);
      if (items.length) return res.json({ text: maybePrependGreetingTip(buildProductsMarkdown(items), meta, FREE_TH) });
    }
    if (/ecolog|eco|biodegrad/i.test(f)) {
      const items = await searchProductsPlain('ecologico biodegradable eco plant-based',5);
      if (items.length) return res.json({ text: maybePrependGreetingTip(buildProductsMarkdown(items), meta, FREE_TH) });
    }

    const wantsBano=/ba[nñ]o/.test(f), wantsCocina=/cocina/.test(f), wantsHorno=/horno/.test(f);
    if (wantsBano || wantsCocina || wantsHorno) {
      const zones=[]; if(wantsBano) zones.push('baño'); if(wantsCocina) zones.push('cocina'); if(wantsHorno) zones.push('horno');
      const items = await recommendZoneProducts(zones);
      if (items.length) {
        let text = `TIP: Te dejo 1 sugerencia por zona. Si quieres alternativas (sin aroma, más eco, etc.) dime y ajusto.\n\n${buildProductsMarkdown(items)}`;
        text = maybePrependGreetingTip(text, meta, FREE_TH);
        return res.json({ text });
      }
    }

    const r = await openai.chat.completions.create({
      model:'gpt-4o-mini',
      tools, tool_choice:'auto',
      messages:[
        { role:'system', content:[
          "Eres el asistente de MundoLimpio.cl.",
          "NUNCA inventes productos, precios ni enlaces.",
          "Para recomendar productos usa la función searchProducts y sus resultados.",
          "Cuando muestres productos, incluye el enlace REAL a /products/{handle}.",
          "Para agregar al carrito: getVariantByOptions -> addToCartClient.",
          "Español Chile, tono claro y con CTA."
        ].join(' ')},
        { role:'user', content: message || '' }
      ]
    });

    const msg = r.choices[0].message;
    if (msg.tool_calls?.length) {
      for (const c of msg.tool_calls) {
        const args = JSON.parse(c.function.arguments || '{}');

        if (c.function.name === 'searchProducts') {
          const d = await sf(`query($q:String!){ search(query:$q, types:PRODUCT, first:5){ edges{ node{ ... on Product{ title handle } } } } }`, { q: args.query });
          const items = (d.search?.edges||[]).map(e=>({title:e.node.title, handle:e.node.handle}));
          let text = buildProductsMarkdown(items);
          if (text) return res.json({ text: maybePrependGreetingTip(text, meta, FREE_TH) });
        }

        if (c.function.name === 'getVariantByOptions') {
          const { handle, options = {} } = args;
          const p = await getProductJsonByHandle(handle);
          const vals = Object.values(options).map(v => String(v).toLowerCase().trim()).filter(Boolean);
          let match = null;
          for (const v of p.variants) {
            const pack = [v.title, v.option1, v.option2, v.option3].filter(Boolean).map(s=>String(s).toLowerCase().trim());
            if (vals.every(val => pack.some(piece => piece.includes(val)))) { match=v; break; }
          }
          if (!match) match = p.variants.find(v=>v.available) || p.variants[0];
          if (!match) throw new Error('Sin variantes para ' + handle);
          return res.json({ toolCalls:[{ id:c.id, name:'addToCartClient', arguments:{ variantId:String(match.id), quantity:1 } }] });
        }
      }
    }

    // Fallback
    try {
      const d = await sf(`query($q:String!){ search(query:$q, types:PRODUCT, first:5){ edges{ node{ ... on Product{ title handle } } } } }`, { q: String(message||'').slice(0,120) });
      const items = (d.search?.edges||[]).map(e=>({ title:e.node.title, handle:e.node.handle }));
      if (items.length) return res.json({ text: maybePrependGreetingTip(buildProductsMarkdown(items), meta, FREE_TH) });
    } catch (err) { console.warn('Fallback searchProducts failed:', err?.message || err); }

    return res.json({ text: userFirstName ? `Gracias, ${userFirstName}. ¿Me das una pista más (marca, superficie, aroma)? También puedo sugerir opciones similares.` : "No encontré resultados exactos. ¿Me das una pista más (marca, superficie, aroma)? También puedo sugerir opciones similares." });

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

