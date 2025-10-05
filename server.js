// server.js — Chat tienda limpieza (Chile) | título-primero + fallback descripción (exclusiones) + cocina/WC/ollas + stock suave
import 'dotenv/config'; import express from 'express'; import cors from 'cors'; import OpenAI from 'openai';

const {
  OPENAI_API_KEY, SHOPIFY_STORE_DOMAIN, SHOPIFY_STOREFRONT_TOKEN, SHOPIFY_PUBLIC_STORE_DOMAIN,
  ALLOWED_ORIGINS, PORT, FREE_SHIPPING_THRESHOLD_CLP, MUNDOPUNTOS_EARN_PER_CLP,
  MUNDOPUNTOS_REDEEM_PER_100, MUNDOPUNTOS_PAGE_URL, BRAND_CAROUSEL_JSON, BEST_SELLERS_COLLECTION_HANDLE
} = process.env;
if (!OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY");
if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_STOREFRONT_TOKEN) throw new Error("Falta SHOPIFY_STORE_DOMAIN o SHOPIFY_STOREFRONT_TOKEN");
if (!SHOPIFY_PUBLIC_STORE_DOMAIN) throw new Error("Falta SHOPIFY_PUBLIC_STORE_DOMAIN");

const app = express(); app.use(express.json({ limit: '1.5mb' }));
const allowed = (ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean);
app.use(cors({ origin: (o,cb)=>(!o||allowed.includes(o))?cb(null,true):cb(new Error('Origen no permitido')), credentials:true }));
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ==== Utils ==== */
const SF_API_VERSION='2025-01', BASE=(SHOPIFY_PUBLIC_STORE_DOMAIN||'').replace(/\/$/,''), FREE_TH_DEFAULT=40000;
const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const fold=s=>norm(s).replace(/ñ/g,'n');
const fmtCLP=n=>new Intl.NumberFormat('es-CL',{style:'currency',currency:'CLP',maximumFractionDigits:0}).format(Math.round(Number(n)||0));
const dedup = arr => Array.from(new Set(arr));
const mapSet = (csv)=>new Set(csv.split(',').map(s=>norm(s.trim())).filter(Boolean));

async function gql(query, variables={}){
  const r=await fetch(`https://${SHOPIFY_STORE_DOMAIN}/api/${SF_API_VERSION}/graphql.json`,{
    method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Storefront-Access-Token':SHOPIFY_STOREFRONT_TOKEN},
    body:JSON.stringify({query,variables})
  });
  if(!r.ok) throw new Error('Storefront API '+r.status);
  const d=await r.json(); if(d.errors) throw new Error(JSON.stringify(d.errors)); return d.data;
}

/* ==== Catálogo ==== */
async function listCollections(n=10){
  const d=await gql(`query($n:Int!){collections(first:$n){edges{node{title handle}}}}`,{n});
  return (d.collections?.edges||[]).map(e=>({title:e.node.title,handle:e.node.handle}));
}
async function searchProductsPlain(query,first=5){
  const d=await gql(`query($q:String!,$n:Int!){
    search(query:$q,types:PRODUCT,first:$n){edges{node{... on Product{title handle availableForSale vendor}}}}
  }`,{q:query,n:first});
  return (d.search?.edges||[]).map(e=>({title:e.node.title,handle:e.node.handle,availableForSale:!!e.node.availableForSale,vendor:(e.node.vendor||'').toLowerCase()}));
}
async function listTopSellers(n=8){
  const h=(BEST_SELLERS_COLLECTION_HANDLE||'').trim();
  try{
    if(h){
      const d=await gql(`query($h:String!,$n:Int!){
        collectionByHandle(handle:$h){products(first:$n,sortKey:BEST_SELLING){edges{node{title handle availableForSale}}}}
      }`,{h,n});
      const it=(d.collectionByHandle?.products?.edges||[]).map(e=>({title:e.node.title,handle:e.node.handle,availableForSale:!!e.node.availableForSale}));
      if(it.length) return it;
    }
  }catch{}
  try{
    const d=await gql(`query($n:Int!){products(first:$n,sortKey:BEST_SELLING){edges{node{title handle availableForSale}}}}`,{n});
    const it=(d.products?.edges||[]).map(e=>({title:e.node.title,handle:e.node.handle,availableForSale:!!e.node.availableForSale}));
    if(it.length) return it;
  }catch{}
  const any=await gql(`query($n:Int!){products(first:$n){edges{node{title handle availableForSale}}}}`,{n});
  return (any.products?.edges||[]).map(e=>({title:e.node.title,handle:e.node.handle,availableForSale:!!e.node.availableForSale}));
}
const buildProductsMarkdown=items=>!items?.length?null:`Aquí tienes opciones:\n\n${items.map((p,i)=>`${i+1}. **[${(p.title||'Ver producto').replace(/\*/g,'')}](${BASE}/products/${p.handle})**`).join('\n')}`;
async function preferInStock(items,need){ const a=items.filter(x=>x.availableForSale),b=items.filter(x=>!x.availableForSale);
  const seen=new Set(),out=[]; for(const it of [...a,...b]){ if(seen.has(it.handle))continue; seen.add(it.handle); out.push(it); if(out.length>=need)break; } return out; }

/* ==== Envíos / regiones ==== */
const REGIONES_LIST=`Arica y Parinacota,Tarapacá,Antofagasta,Atacama,Coquimbo,Valparaíso,O’Higgins,O'Higgins,Maule,Ñuble,Biobío,Araucanía,Los Ríos,Los Lagos,Metropolitana,Santiago,Aysén,Magallanes`.split(',');
const REGIONES_F=new Set(REGIONES_LIST.map(fold));
const COMUNAS=`Las Condes,Vitacura,Lo Barnechea,Providencia,Ñuñoa,La Reina,Santiago,Macul,La Florida,Puente Alto,Maipú,Maipu,Huechuraba,Independencia,Recoleta,Quilicura,Conchalí,Conchali,San Miguel,San Joaquín,San Joaquin,La Cisterna,San Bernardo,Colina,Buin,Lampa`.split(',');
const COMUNAS_F=new Set(COMUNAS.map(fold));
const SHIPPING_ZONES=[
  {z:'REGIÓN METROPOLITANA',c:3990,r:['Metropolitana','Santiago']},
  {z:'ZONA CENTRAL',c:6990,r:['Coquimbo','Valparaíso','Valparaiso',"O’Higgins","O'Higgins",'Maule','Ñuble','Nuble','Biobío','Biobio','Araucanía','Araucania','Los Ríos','Los Rios','Los Lagos']},
  {z:'ZONA NORTE',c:10990,r:['Arica y Parinacota','Tarapacá','Tarapaca','Antofagasta','Atacama']},
  {z:'ZONA AUSTRAL',c:14990,r:['Aysén','Aysen','Magallanes']}
];
const REGION_COST_MAP=(()=>{const m=new Map(); for(const s of SHIPPING_ZONES) for(const r of s.r) m.set(fold(r),{zone:s.z,cost:s.c}); m.set('metropolitana',{zone:'REGIÓN METROPOLITANA',cost:3990}); m.set('santiago',{zone:'REGIÓN METROPOLITANA',cost:3990}); return m;})();
const shippingByRegionName=s=>REGION_COST_MAP.get(fold(s))||null;
const regionsPayloadLines=()=>dedup(REGIONES_LIST.map(r=>r.replace(/\"/g,''))).map(r=>`${r}|${r}`).join('\n');

/* ==== Shopping list ==== */
const SHOPPING_SYNONYMS={
  'lavalozas':['lavalozas','lava loza','lavaplatos','dishwashing','lavavajillas liquido','dawn','quix'],
  'antigrasa':['antigrasa','desengrasante','degreaser','kh-7','kh7'],
  'multiuso':['multiuso','all purpose','limpiador multiuso','cif crema','pink stuff'],
  'esponja':['esponja','fibra','sponge','scrub daddy'],
  'parrillas':['limpiador parrilla','bbq','grill','goo gone bbq','desengrasante parrilla'],
  'piso':['limpiador pisos','floor cleaner','bona','lithofin'],
  'alfombra':['limpiador alfombra','tapiceria','tapiz','dr beckmann'],
  'vidrio':['limpia vidrios','glass cleaner','weiman glass'],
  'acero':['limpiador acero inoxidable','weiman acero'],
  'protector textil':['protector textil','impermeabilizante telas','fabric protector'],
  'cocina':['limpiador cocina','limpiador de cocina','antigrasa cocina','desengrasante cocina'],
  'desodorante wc':['desodorante wc','neutralizador wc','neutralizador olores wc','spray wc','aromatizante wc','desodorante baño wc','dejapoo'],
  'desodorante baño':['desodorante baño','aromatizante baño','spray baño','neutralizador olores baño','dejapoo'],
  'neutralizador wc':['neutralizador wc','neutralizador olores wc','desodorante wc','spray wc','dejapoo'],
  'ollas':['pasta multiuso','pink stuff pasta','desengrasante cocina','limpiador acero inoxidable','lavalozas','esponja','fibra','scrub daddy','sarten','cacerola','olla']
};
const KNOWN_BRANDS=['astonish','weiman','goo gone','dr beckmann','dr. beckmann','kh7','kh-7','bona','lithofin','rexona','febreze','vileda','quix','dejapoo','the pink stuff','pink stuff'];

const tokenize=s=>norm(s).replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(Boolean);
const detectBrandIn=t=>{const q=norm(t); for(const b of KNOWN_BRANDS){ if(q.includes(b)) return b; } return null; };
const splitShopping=t=>{const base=t.split(':').slice(1).join(':')||t; return base.split(/,|\by\b/gi).map(s=>s.trim()).filter(Boolean);};

/* ==== Descripción (body:) exclusiones/whitelist ==== */
const BODY_EXCLUDE=mapSet([
  // funcionales/conectores + uso/marketing + genéricas + unidades + ecom + relleno (compactado)
  'el,la,los,las,un,una,unos,unas,de,del,al,a,en,con,por,para,sin,sobre,entre,tras,desde,hasta,hacia,y,e,o,u,ni,que,como,donde,cuando,cual,cuales,cuyo,cuya,cuyos,cuyas,este,esta,estos,estas,ese,esa,esos,esas,aquel,aquella,aquellos,aquellas,lo,le,les,se,me,te,nos,os,su,sus,mi,mis,tu,tus,nuestro,nuestra,nuestros,nuestras,si,no,ya,aun,aún,tambien,también,ademas,mas,más,menos,muy,quiza,quizas,tal,tan,tanto,uso,usar,utilizar,empleo,metodo,método,modo,forma,manera,paso,pasos,guia,guía,instruccion,instrucción,instrucciones,indicado,indicada,indicados,recomendacion,recomendación,recomendado,recomendada,sirve,servir,ayuda,ayudar,permite,permitir,aplicar,aplicacion,aplicación,aplicado,aplicada,agitar,verter,diluir,enjuagar,enjuague,secar,frotar,rociar,pulverizar,repetir,dejar,esperar,mejor,eficaz,efectivo,eficiente,potente,rapido,rápido,seguro,confiable,durable,duradero,resistente,profesional,avanzado,original,nuevo,nueva,innovador,innovadora,superior,alto,alta,maxima,máxima,optimo,óptimo,optima,óptima,excelente,ideal,especial,adecuado,adecuada,versatil,versátil,facil,fácil,practico,práctico,limpieza,limpiar,aseo,hogar,casa,superficie,superficies,producto,productos,solucion,solución,formula,fórmula,contenido,contiene,elimina,remueve,quita,protege,cuida,actua,actúa,reduce,previene,ml,l,lt,litro,litros,g,gr,kg,kilo,kilos,oz,onzas,cm,mm,m,unidad,unidades,pack,set,formato,tamaño,tamano,presentacion,presentación,x,por,c/u,cu,aprox,1,2,3,4,5,6,7,8,9,0,250,300,355,400,500,650,700,710,750,946,950,1000,3780,3.78,oferta,promo,promoción,promocion,descuento,rebaja,precio,precios,normal,ahora,envio,envío,despacho,stock,disponible,disponibilidad,garantia,garantía,caja,cajas,codigo,código,sku,ref,referencia,hecho,fabricado,fabricada,desarrollado,desarrollada,diseñado,diseñada,compatible,diario,cotidiano,multiuso,multi-uso,multiusos,multi-usos,domestico,doméstico,industrial'
].join(','));
const BODY_WHITELIST=mapSet('cocina,baño,bano,wc,olla,ollas,sarten,sartén,sartenes,cacerola,acero,inox,vidrio,alfombra,piso,pisos,madera,ropa');

function tokenClean(s=''){ return tokenize(s).map(t=>t.replace(/s$/,'')).filter(t=>t.length>=3 && !STOPWORDS.has(t)); }
const GENERIC_TOKENS=new Set(['limpiar','limpieza','limpiador','limpiadores']);
const STOPWORDS=new Set('la,el,los,las,de,del,para,por,con,y,o,u,un,una,unos,unas,al,en,mi,tu,su,sus,que,qué,como,cómo,quiero,necesito,recomiendas,recomendar,limpiar,limpieza,mucho,poco,tengo,hay,me,mi'.split(',').map(norm));

/* ==== body queries ==== */
function bodyQueriesFromText(text=''){
  const raw=tokenClean(text);
  const toks=raw.filter(t=>(!BODY_EXCLUDE.has(t)||BODY_WHITELIST.has(t)) && !/^\d+(?:[.,]\d+)?$/.test(t));
  if(!toks.length) return [];
  const qs=[ toks.map(t=>`body:${t}`).join(' '), ...toks.map(t=>`body:${t}`) ];
  const phrase=String(text||'').trim(); if(phrase.length>=6) qs.push(`body:"${phrase.slice(0,100)}"`);
  const out=[]; const seen=new Set(); for(const q of qs){ const k=q.trim(); if(!k||seen.has(k)) continue; seen.add(k); out.push(k); if(out.length>=10) break; }
  return out;
}

/* ==== superficies & boosts ==== */
function detectSurface(t=''){const q=norm(t);
  if(/\b(baño|bano|wc)\b/.test(q)) return 'bano';
  if(/\bcocina\b/.test(q)) return 'cocina';
  if(/\b(alfombra|tapiz|tapiceria)\b/.test(q)) return 'alfombra';
  if(/\b(piso|pisos|parquet|flotante)\b/.test(q)) return 'pisos';
  if(/\b(vidrio|ventana|cristal)\b/.test(q)) return 'vidrio';
  if(/\bmadera\b/.test(q)) return 'madera';
  if(/\b(acero|inox|acero inoxidable)\b/.test(q)) return 'acero';
  if(/\b(ropa|polera|camisa|jean|zapatilla)\b/.test(q)) return 'ropa';
  if(/\b(olla|ollas|cacerol|sarten|sart[eé]n|sartenes)\b/.test(q)) return 'ollas';
  return null;
}
function surfaceQueryBoost(s){
  const m={bano:['limpiador baño','antihongos baño','quita sarro baño','desinfectante baño','wc'],
    cocina:['desengrasante cocina','limpiador cocina','antigrasa cocina','acero inoxidable cocina'],
    alfombra:['limpiador alfombra','tapicería','quitamanchas alfombra','dr beckmann'],
    pisos:['limpiador pisos','bona','lithofin','abrillantador pisos'],
    vidrio:['limpia vidrios','glass cleaner','antiempañante vidrio'],
    madera:['limpiador madera','acondicionador madera','abrillantador madera'],
    acero:['limpiador acero inoxidable','weiman acero','polish acero'],
    ropa:['quitamanchas ropa','blanqueador ropa','detergente capsulas'],
    ollas:['pasta multiuso','pink stuff pasta','desengrasante cocina','limpiador cocina','limpiador acero inoxidable','lavalozas','esponja','fibra','scrub daddy']};
  return m[s]||[];
}
const SURFACE_CLASH={bano:['madera','granito','vidrio','parquet'],cocina:['baño','wc'],alfombra:['madera','acero','vidrio'],pisos:['alfombra','tapiz'],vidrio:['madera','alfombra'],madera:['baño','wc'],acero:['madera','alfombra'],ropa:['madera','parrilla','pisos']};
const clashPenalty=(s,t='')=>!s?0:(SURFACE_CLASH[s]||[]).reduce((p,w)=>p+(norm(t).includes(norm(w))?-2:0),0);

/* ==== Query makers ==== */
function makeQueriesFromText(text=''){
  const toks=tokenClean(text), out=[]; const s=detectSurface(text); for(const b of (s?surfaceQueryBoost(s):[])) out.push(b);
  if(toks.length){ const joined=toks.filter(t=>!GENERIC_TOKENS.has(t)).join(' ').trim(); if(joined) out.push(joined); for(const t of toks){ if(!GENERIC_TOKENS.has(t)) out.push(t); } }
  for(const key of Object.keys(SHOPPING_SYNONYMS)) if(norm(text).includes(norm(key))) out.push(key);
  const res=[]; const seen=new Set(); for(const q of out){ const k=String(q||'').trim(); if(!k||seen.has(k)) continue; seen.add(k); res.push(k); if(res.length>=12) break; }
  return res.length?res:[String(text||'').slice(0,120)];
}
async function buildPoolByQueries(queries,cap=72){const pool=[],seen=new Set();
  for(const q of queries){ const found=await searchProductsPlain(q,18).catch(()=>[]); for(const it of found){ if(seen.has(it.handle)) continue; seen.add(it.handle); pool.push(it); if(pool.length>=cap) return pool; } }
  return pool;
}

/* ==== Scoring título ==== */
function scoreTitleStrict(userText,title){
  const u=tokenClean(userText), t=tokenClean(title), uSet=new Set(u), tSet=new Set(t);
  const hits=[...uSet].reduce((n,x)=>n+(tSet.has(x)?1:0),0);
  const jacc=(()=>{const inter=[...uSet].filter(x=>tSet.has(x)).length; const uni=new Set([...uSet,...tSet]).size||1; return inter/uni;})();
  const s=detectSurface(userText||''), penalty=clashPenalty(s,title);
  let surfaceBonus=0; if(s==='ollas' && /(olla|cacerol|sart[eé]n|sartenes|cookware|acero inoxidable)/i.test(title||'')) surfaceBonus+=2;
  return {hits,jacc,score:(hits*3)+(jacc*1.2)+penalty+surfaceBonus};
}

/* ==== Título primero ==== */
async function recommendByTitleFirst(userText,max=6){
  const pool=await buildPoolByQueries(makeQueriesFromText(userText),72); if(!pool.length) return [];
  const scored=pool.map(p=>{const {hits,jacc,score}=scoreTitleStrict(userText,p.title||''); return {...p,_hits:hits,_jacc:jacc,_score:score};});
  let cand=scored.filter(x=>x._hits>0); if(!cand.length) cand=scored.filter(x=>x._jacc>0);
  if(!cand.length){
    const fb=await titleMatchProducts(userText,max); if(fb?.length) return fb;
    const bqs=bodyQueriesFromText(userText), seen=new Set(), body=[]; for(const q of bqs){ const f=await searchProductsPlain(q,18).catch(()=>[]); for(const it of f){ if(seen.has(it.handle)) continue; seen.add(it.handle); body.push(it); if(body.length>=36) break; } if(body.length>=36) break; }
    return body.length?body.sort((a,b)=>a.availableForSale!==b.availableForSale?(a.availableForSale?-1:1):0).slice(0,max):[];
  }
  cand.sort((a,b)=>a.availableForSale!==b.availableForSale?(a.availableForSale?-1:1): a._hits!==b._hits?b._hits-a._hits : b._score-a._score);
  return cand.slice(0,max);
}

/* ==== Fallbacks adicionales ==== */
function extractKeywords(text='',max=8){
  const tokens=tokenize(text).filter(t=>t.length>=3);
  const stop=new Set('tienen,venden,quiero,necesito,precio,productos,producto,limpieza,limpiar,ayuda,me,puedes,recomendar,stock,stok,disponible,disponibilidad,quedan,inventario,cuanto,cuánta,cuanta,limpio,mucho,poco'.split(',').map(norm));
  const bag=[],seen=new Set(); for(const t of tokens){ if(stop.has(t)) continue; const base=t.replace(/s$/,''); if(seen.has(base)) continue; seen.add(base); bag.push(base); if(bag.length>=max) break; } return bag;
}
async function titleMatchProducts(q,max=6){
  const pool=await searchProductsPlain(String(q||'').slice(0,120),36); if(!pool.length) return [];
  const kws=extractKeywords(q,10); if(!kws.length) return (await preferInStock(pool,max)).slice(0,max);
  const fld=s=>norm(s), scored=pool.map(p=>({...p,_hits:kws.reduce((n,kw)=>n+(fld(p.title).includes(kw)?1:0),0)}));
  const byHits=scored.sort((a,b)=>b._hits-a._hits).filter(x=>x._hits>0);
  const shortlist=(byHits.length?byHits:pool).slice(0,max*2);
  return shortlist.sort((a,b)=>a.availableForSale!==b.availableForSale?(a.availableForSale?-1:1):(b._hits||0)-(a._hits||0)).slice(0,max);
}

/* ==== Precisión por segmento (shopping) ==== */
function buildPreciseQueriesForSegment(phrase){
  const q=phrase.trim(), nq=norm(q), brand=detectBrandIn(q),
    isCocina=/\bcocina\b/.test(nq),
    isWCDeo=((/(\bdesodorante|neutralizador|aromatizante|spray)\b/.test(nq)&&/(\bwc|bañ|bano)\b/.test(nq))||/\b(desodorante\s*wc|neutralizador\s*wc)\b/.test(nq)),
    isCookware=/\b(olla|ollas|cacerol|sarten|sart[eé]n|sartenes)\b/.test(nq);
  const queries=[]; if(q.length>=6) queries.push(`"${q.slice(0,120)}"`);
  for(const k of Object.keys(SHOPPING_SYNONYMS)) if(nq.includes(k)) queries.push(...SHOPPING_SYNONYMS[k]);
  if(/\blimpiador( de)? cocina\b/.test(nq)) queries.push(...SHOPPING_SYNONYMS['cocina']);
  const titleTerms=[]; if(isCocina) titleTerms.push('cocina'); if(/bañ|bano|wc/.test(nq)) titleTerms.push('baño'); if(/alfombra|tapiz|tapicer/.test(nq)) titleTerms.push('alfombra'); if(/limpiador\b/.test(nq)&&isCocina) titleTerms.push('limpiador');
  if(titleTerms.length){ queries.push(titleTerms.map(t=>`title:${t}`).join(' ')); if(brand) queries.push(titleTerms.map(t=>`title:${t}`).join(' ')+' vendor:'+brand); }
  if(isWCDeo){ const wc=['desodorante wc','neutralizador wc','neutralizador olores wc','spray wc','aromatizante wc','desodorante baño wc','aromatizante baño wc','neutralizador olores baño wc'];
    queries.push(...wc); if(brand){ for(const s of wc) queries.push(`${s} vendor:${brand}`); queries.push(`title:wc vendor:${brand}`,`title:wc title:neutralizador vendor:${brand}`,`title:wc title:desodorante vendor:${brand}`); } }
  if(isCookware){ const cw=['pasta multiuso','pink stuff pasta','desengrasante cocina','limpiador cocina','limpiador acero inoxidable','lavalozas','esponja','fibra','scrub daddy'];
    queries.push(...cw); if(brand){ for(const s of cw) queries.push(`${s} vendor:${brand}`); queries.push('title:olla vendor:'+brand,'title:sarten vendor:'+brand,'title:acero vendor:'+brand); }
    else queries.push('title:olla','title:sarten','title:cacerola','title:acero inoxidable'); }
  const toks=tokenize(q).filter(t=>t.length>=3 && !['limpiar','limpieza','limpiador','especialista','de','para'].includes(t));
  if(toks.length){ queries.push(toks.join(' '),...toks); }
  const out=[], seen=new Set(); for(const x of queries){ const k=x.trim(); if(!k||seen.has(k)) continue; seen.add(k); out.push(k); if(out.length>=14) break; }
  return {queries:out,brand,isCocina,isWCDeo,isCookware};
}
async function bestMatchForPhrase(phrase){
  const syn=SHOPPING_SYNONYMS[norm(phrase)]||[phrase], {queries:precise,brand,isCocina,isWCDeo,isCookware}=buildPreciseQueriesForSegment(phrase);
  const pool=[], seen=new Set(); const add=async(q,n=10)=>{ const f=await searchProductsPlain(q,n).catch(()=>[]); for(const it of f){ if(seen.has(it.handle)) continue; seen.add(it.handle); pool.push(it);} };
  for(const q of precise){ await add(q,12); if(pool.length>=18) break; }
  if(pool.length<6) for(const q of syn){ await add(q,10); if(pool.length>=18) break; }
  if(pool.length<3){ for(const t of tokenize(phrase).filter(t=>t.length>=3).slice(0,3)){ await add(t,6); if(pool.length>=12) break; } }
  if(!pool.length){ for(const q of bodyQueriesFromText(phrase)){ await add(q,10); if(pool.length>=12) break; } }
  if(!pool.length) return null;
  let filtered=pool;
  if(isCocina){ const f=filtered.filter(p=>!/bbq|parrilla|grill/i.test(p.title||'')); if(f.length) filtered=f; }
  if(isWCDeo){ const hard=/limpiador|antisarro|desinfect|recarga\s+baño|kh7\s*baño/i; const f=filtered.filter(p=>!hard.test(p.title||'')); if(f.length) filtered=f; }
  if(isCookware){ const f=filtered.filter(p=>!/piso|pisos|m[aá]rmol|parquet|bbq|parrilla|grill/i.test(p.title||'')); if(f.length) filtered=f; }
  const ranked=filtered.map(x=>{let b=0; if(isCocina&&/cocina/i.test(x.title||'')) b+=2; if(isWCDeo&&/(wc|neutralizador|aromatizante|spray|olores)/i.test(x.title||'')) b+=3; if(isCookware&&/(olla|cacerol|sart[eé]n|sartenes|acero inoxidable|cookware)/i.test(x.title||'')) b+=3; if(brand&&(x.vendor||'').includes(brand)) b+=2; if(/\bdejapoo\b/.test(norm(phrase))&&/\bdejapoo\b/i.test(x.title||'')) b+=2; return {...x,_b:b};})
    .sort((a,b)=>a.availableForSale!==b.availableForSale?(a.availableForSale?-1:1):b._b-a._b);
  return ranked[0]||filtered[0]||pool[0];
}
async function selectProductsByOrderedKeywords(msg){ const parts=splitShopping(msg||''); if(parts.length<2) return null;
  const picks=[], used=new Set(); for(const seg of parts){ const m=await bestMatchForPhrase(seg); if(m&&!used.has(m.handle)){picks.push(m); used.add(m.handle);} } return picks.length?picks:null; }

/* ==== IA (tips) ==== */
const AI_POLICY=`Eres el asistente de MundoLimpio.cl (Chile), experto en limpieza.
Responde primero con 3–5 bullets (pasos claros y seguros).
NO incluyas CTAs ni enlaces/marcas/links en el TIP.
Tono cercano y breve. No inventes stock, marcas ni precios.`;
const AI_PRODUCT_QUERY=`Eres un extractor de intención para una tienda de limpieza en Chile.
Responde SOLO con JSON: {"keywords":["antihongos","limpiador baño"],"brands":["Paso"],"max":6}
- "keywords": 2–4 términos (es-CL) de categoría/superficie/uso.
- "brands": SOLO si el usuario la mencionó.
- "max": 3 a 8.`;
async function aiProductQuery(t){
  try{
    const ai=await openai.chat.completions.create({model:'gpt-4o-mini',temperature:0,messages:[{role:'system',content:AI_PRODUCT_QUERY},{role:'user',content:String(t||'').slice(0,500)}]});
    const raw=(ai.choices?.[0]?.message?.content||'').trim(); const m=raw.match(/\{[\s\S]*\}/); const p=JSON.parse(m?m[0]:raw);
    const keywords=(Array.isArray(p.keywords)?p.keywords:[]).map(String).map(s=>s.trim()).filter(Boolean).filter(k=>!GENERIC_TOKENS.has(norm(k))).slice(0,6);
    const brands=(Array.isArray(p.brands)?p.brands:[]).map(String).map(s=>s.trim()).filter(Boolean).slice(0,3);
    const max=Math.max(3,Math.min(8,Number(p.max||6)||6)); return {keywords,brands,max};
  }catch{return {keywords:[],brands:[],max:6};}
}
async function searchByQueries(keywords=[],brands=[],max=6){
  const qs=[]; for(const k of keywords){ if(!k||GENERIC_TOKENS.has(norm(k))) continue; qs.push(k); for(const b of brands){ qs.push(`${k} ${b}`,`${b} ${k}`); } }
  if(!qs.length&&brands.length) qs.push(...brands); if(!qs.length) return [];
  const pool=[], seen=new Set(); for(const q of qs.slice(0,12)){ const f=await searchProductsPlain(q,12).catch(()=>[]); for(const it of f){ if(seen.has(it.handle)) continue; seen.add(it.handle); pool.push(it); if(pool.length>=max*3) break; } if(pool.length>=max*3) break; }
  return pool.sort((a,b)=>a.availableForSale!==b.availableForSale?(a.availableForSale?-1:1):0).slice(0,max);
}

/* ==== STOCK ==== */
const STOCK_REGEX=/\b(stock|en\s+stock|stok|disponible|disponibilidad|quedan?|inventario)\b/i;
const extractHandleFromText=s=>{const m=String(s||'').match(/\/products\/([a-z0-9\-_%\.]+)/i); return m?m[1]:null;};
const tokenizeStrict=s=>String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(Boolean);
function extractBrandTokens(t=''){const q=tokenizeStrict(t).join(' '), hits=[]; for(const b of KNOWN_BRANDS){ if(q.includes(b)) hits.push(b);} return dedup(hits);}
function scoreTitleForStock(title='',tokens=[],brandTokens=[]){const t=new Set(tokenizeStrict(title)); let s=0; for(const tok of tokens) if(t.has(tok)) s++; for(const b of brandTokens){const parts=b.split(' '); if(parts.every(p=>t.has(p))) s+=2;} if(tokens.includes('pasta')&&t.has('pasta')) s++; if((tokens.includes('multiuso')||tokens.includes('multiusos'))&&(t.has('multiuso')||t.has('multiusos'))) s++; return s;}
async function findHandleForStock(message='',meta={}){
  const brandT=extractBrandTokens(message), raw=tokenizeStrict(message).filter(w=>w.length>=3),
    stop=new Set('la,el,de,del,para,con,una,un,los,las,tienen,tiene,hay,queda,quedan,stock,en,cuanto,cuánta,cuanta,original,producto'.split(','));
  const tokens=raw.filter(t=>!stop.has(t)), qs=[]; if(brandT.length){const b=brandT[0]; if(tokens.length){qs.push(tokens.join(' ')+' '+b,b+' '+tokens.join(' '));} else qs.push(b);} if(tokens.length) qs.push(tokens.join(' '));
  if(meta?.page?.url&&/\/products\//i.test(meta.page.url)){const m=meta.page.url.match(/\/products\/([a-z0-9\-_%\.]+)/i); if(m&&m[1]) return m[1];}
  const pool=[], seen=new Set(); for(const q of qs.slice(0,4)){ const f=await searchProductsPlain(q,15).catch(()=>[]); for(const it of f){ if(seen.has(it.handle)) continue; seen.add(it.handle); pool.push(it);} }
  if(!pool.length) return null;
  const scored=pool.map(p=>({...p,_score:scoreTitleForStock(p.title,tokens,brandT)})),
    good=scored.filter(x=>x._score>=2),
    requirePasta=tokens.includes('pasta'),
    list=(requirePasta?good.filter(x=>/pasta/i.test(x.title)):good).sort((a,b)=>a.availableForSale!==b.availableForSale?(a.availableForSale?-1:1):b._score-a._score);
  return (list[0]||scored.sort((a,b)=>a.availableForSale!==b.availableForSale?(a.availableForSale?-1:1):b._score-a._score)[0])?.handle||null;
}
function pluralUnidad(n){return Number(n)===1?'unidad':'unidades';}
function pluralDisponible(n){return Number(n)===1?'disponible':'disponibles';}
const isDefaultVariantTitle=t=>/default\s*title/i.test(String(t||''));

/* ==== Intents ==== */
const PURPOSE_REGEX=/\b(para que sirve|para qué sirve|que es|qué es|como usar|cómo usar|modo de uso|instrucciones|paso a paso|como limpiar|cómo limpiar|consejos|tips|guia|guía|pasos)\b/i;
function detectIntent(text=''){
  const q=norm(text), m=String(text||'').match(/^env[ií]o\s+(.+)$/i); if(m){const loc=fold(m[1]); if(REGIONES_F.has(loc)||COMUNAS_F.has(loc)) return 'shipping_region';}
  if(STOCK_REGEX.test(text||'')) return 'stock';
  if(REGIONES_F.has(fold(text))||COMUNAS_F.has(fold(text))) return 'shipping_region';
  if(/(mas vendidos|más vendidos|best sellers|top ventas|lo mas vendido|lo más vendido)/.test(q)) return 'tops';
  if(/(envio|env[ií]o|despacho|retiro)/.test(q)) return 'shipping';
  if(/(mundopuntos|puntos|fidelizaci[óo]n)/.test(q)) return 'points';
  if(/(que marcas|qué marcas|marcas venden|marcas disponibles)/.test(q)) return 'brands';
  if(/(categorias|categorías|tipos de productos|colecciones|que productos venden|qué productos venden)/.test(q)) return 'categories';
  if(PURPOSE_REGEX.test(text)) return 'info';
  const commaCount=(text.match(/,/g)||[]).length, looksLike=/\b\w+\b\s*,\s*\b\w+\b\s*(?:,|\by\b)\s*\b\w+\b/i.test(text);
  if(/(necesito:|lista:|comprar:|quiero:)/.test(q)||commaCount>=2||looksLike) return 'shopping';
  return 'browse';
}
const parseBrandCarouselConfig=()=>{try{return JSON.parse(BRAND_CAROUSEL_JSON||'');}catch{return[];}};

/* ==== Stock Storefront ==== */
async function fetchStorefrontStockByHandle(h){
  const d=await gql(`query($h:String!){
    productByHandle(handle:$h){title variants(first:100){edges{node{title availableForSale quantityAvailable}}}}
  }`,{h});
  const p=d.productByHandle; if(!p) return null;
  const variants=(p.variants?.edges||[]).map(e=>({title:e.node.title||'Default Title',available:!!e.node.availableForSale,quantityAvailable: typeof e.node.quantityAvailable==='number'?e.node.quantityAvailable:null}));
  const totals=variants.map(v=>typeof v.quantityAvailable==='number'?v.quantityAvailable:0).reduce((a,b)=>a+b,0);
  const hasNum=variants.some(v=>typeof v.quantityAvailable==='number');
  return {title:p.title||'Producto',variants,total: hasNum?totals:null};
}

/* ==== Endpoint ==== */
app.post('/chat', async (req,res)=>{
  try{
    const { message, toolResult, meta={} }=req.body; const FREE_TH=Number(FREE_SHIPPING_THRESHOLD_CLP??FREE_TH_DEFAULT);
    if(toolResult?.id) return res.json({text:"¡Listo! Producto agregado 👍"});
    const intent=detectIntent(message||'');

    /* STOCK */
    if(intent==='stock'){
      let handle=extractHandleFromText(message||'') || (meta?.page?.url?/\/products\//i.test(meta.page.url)&&extractHandleFromText(meta.page.url):null);
      if(!handle){ try{handle=await findHandleForStock(message||'',meta);}catch{} }
      if(!handle){ try{const f=await titleMatchProducts(message||'',1); if(f?.[0]) handle=f[0].handle;}catch{} }
      if(!handle) return res.json({text:"Compárteme el **link** del producto o su **nombre exacto** y te digo el stock."});
      const info=await fetchStorefrontStockByHandle(handle); if(!info) return res.json({text:"No encontré ese producto. ¿Puedes confirmarme el nombre o enviar el link?"});
      if(info.total!==null){
        const qty=info.total, header=`Actualmente contamos con ${qty} ${pluralUnidad(qty)} ${pluralDisponible(qty)} de **${info.title}**.`;
        const withQty=info.variants.filter(v=>typeof v.quantityAvailable==='number');
        if(withQty.length===1){const v=withQty[0]; const label=isDefaultVariantTitle(v.title)?'**Stock disponible:**':`**Variante ${v.title} — Stock:**`; return res.json({text:`${header}\n${label} ${v.quantityAvailable} ${pluralUnidad(v.quantityAvailable)}`});}
        if(withQty.length>1){const lines=withQty.map(v=>`${isDefaultVariantTitle(v.title)?'Variante única':`Variante ${v.title}`}: ${v.quantityAvailable} ${pluralUnidad(v.quantityAvailable)}`); return res.json({text:`${header}\n**Detalle por variante:**\n${lines.join('\n')}`});}
        return res.json({text:`${header}\n**Stock disponible:** ${qty} ${pluralUnidad(qty)}`});
      }
      const avail=info.variants.filter(v=>v.available);
      if(avail.length){const lines=avail.map(v=>`${isDefaultVariantTitle(v.title)?'Variante única':`Variante ${v.title}`}: disponible`); return res.json({text:`Disponibilidad de **${info.title}**:\n${lines.join('\n')}`});}
      return res.json({text:`Por ahora **${info.title}** no muestra stock disponible.`});
    }

    /* TOPS */
    if(intent==='tops'){ const items=await listTopSellers(10).then(xs=>preferInStock(xs,8)); if(!items.length) return res.json({text:"Por ahora no tengo un ranking de más vendidos."}); return res.json({text:buildProductsMarkdown(items)}); }

    /* BRANDS */
    if(intent==='brands'){
      const custom=parseBrandCarouselConfig(); if(custom.length){ const lines=custom.map(b=>[b.title,b.url,b.image||''].join('|')).join('\n'); return res.json({text:`BRANDS:\n${lines}`}); }
      const d=await gql(`query{products(first:120){edges{node{vendor}}}}`); const vendors=(d.products?.edges||[]).map(e=>String(e.node.vendor||'').trim()).filter(Boolean);
      const top=Array.from(new Set(vendors)).slice(0,48); if(top.length){ const payload=top.map(v=>`${v}|${BASE}/collections/vendors?q=${encodeURIComponent(v)}|`).join('\n'); return res.json({text:`BRANDS:\n${payload}`}); }
      return res.json({text:'Trabajamos varias marcas internacionales y locales. ¿Cuál te interesa?'});
    }

    /* CATEGORIES */
    if(intent==='categories'){
      const cols=await listCollections(12); if(cols.length){ const payload=cols.map(c=>`${c.title}|${BASE}/collections/${c.handle}`).join('\n'); return res.json({text:`CATS:\n${payload}`}); }
      const fallback=[['LIMPIEZA Y ASEO',`${BASE}/search?q=limpieza`],['LAVADO DE ROPA',`${BASE}/search?q=ropa`],['CUIDADO PERSONAL',`${BASE}/search?q=personal`],['COCINA',`${BASE}/search?q=cocina`],['BAÑO',`${BASE}/search?q=ba%C3%B1o`],['PISOS',`${BASE}/search?q=pisos`]];
      return res.json({text:`CATS:\n${fallback.map(([t,u])=>`${t}|${u}`).join('\n')}`});
    }

    /* SHIPPING general */
    if(intent==='shipping'){
      const header=Number(FREE_TH)>0?`En **RM** hay **envío gratis** sobre **${fmtCLP(FREE_TH)}**.`:`Hacemos despacho a **todo Chile**.`;
      const tarifas=`Tarifas por zona:
- **REGIÓN METROPOLITANA**: ${fmtCLP(3990)}
- **ZONA CENTRAL**: ${fmtCLP(6990)} (Coquimbo, Valparaíso, O’Higgins, Maule, Ñuble, Biobío, Araucanía, Los Ríos, Los Lagos)
- **ZONA NORTE**: ${fmtCLP(10990)} (Arica y Parinacota, Tarapacá, Antofagasta, Atacama)
- **ZONA AUSTRAL**: ${fmtCLP(14990)} (Aysén, Magallanes)`;
      return res.json({text:`${header}\nEl costo se calcula en el **checkout** según **región y comuna**. Elige tu región para ver el costo referencial:\n\nREGIONS:\n${regionsPayloadLines()}\n\n${tarifas}`});
    }

    /* SHIPPING región */
    if(intent==='shipping_region'){
      const q=String(message||'').trim();
      if(REGIONES_F.has(fold(q))||/^env[ií]o\s+/i.test(q)){
        const reg=q.replace(/^env[ií]o\s+/i,'').trim(), ship=shippingByRegionName(reg), isRM=/metropolitana|santiago/.test(fold(reg));
        const parts=[]; parts.push(ship?`Para **${reg}** (${ship.zone}) el costo referencial es **${fmtCLP(ship.cost)}**.`:`Para **${reg}** el costo se calcula en el checkout por región/comuna.`);
        if(isRM&&Number(FREE_TH)>0) parts.push(`En **RM** hay **envío gratis** sobre **${fmtCLP(FREE_TH)}**.`); return res.json({text:parts.join(' ')});
      }
      if(COMUNAS_F.has(fold(q))) return res.json({text:`Despachamos a **todo Chile**. Para **${q}**, ingresa tu **región/comuna** en el checkout y verás el costo exacto. Si me dices tu **región**, te doy el costo referencial.`});
    }

    /* Puntos */
    if(intent==='points'){
      const earn=Number(MUNDOPUNTOS_EARN_PER_CLP||1), redeem100=Number(MUNDOPUNTOS_REDEEM_PER_100||3), url=(MUNDOPUNTOS_PAGE_URL||'').trim();
      return res.json({text:`**Mundopuntos**: ganas **${earn} punto(s) por $1**. Canje: **100 puntos = ${fmtCLP(redeem100)}**. ${url?`Más info: ${url}`:'Adminístralo en el widget de recompensas.'}`});
    }

    /* Shopping list */
    if(intent==='shopping'){
      const picks=await selectProductsByOrderedKeywords(message||''); if(picks?.length) return res.json({text:`Te dejo una opción por ítem:\n\n${buildProductsMarkdown(picks)}`});
      // cae a recomendación normal
    }

    /* Info/Browse: tips + recomendación */
    if(intent==='info'||intent==='browse'){
      let items=[]; try{ items=await recommendByTitleFirst(message||'',6);}catch{}
      if(!items.length){ try{ const {keywords,brands,max}=await aiProductQuery(message||''); if(keywords.length||brands.length) items=await searchByQueries(keywords,brands,Math.min(6,max)); }catch{} }
      if(!items.length){
        const qn=norm(message||'');
        if(/(impermeabiliz|protector).*(sillon|sof[aá]|tapiz)/.test(qn)) items=(await searchProductsPlain('protector textil',12)).slice(0,3);
        else if(/(olla|ollas|cacerol|sart[eé]n|sartenes)/.test(qn)){
          const pool=[], qs=['pasta multiuso','pink stuff pasta','desengrasante cocina','limpiador cocina','limpiador acero inoxidable','lavalozas','esponja','fibra','scrub daddy','title:olla','title:sarten','title:cacerola','title:acero inoxidable'];
          for(const q of qs){ const f=await searchProductsPlain(q,8).catch(()=>[]); pool.push(...f.filter(p=>!/piso|pisos|m[aá]rmol|parquet|bbq|parrilla|grill/i.test(p.title||''))); }
          items=pool.map(x=>({...x,_b: /(olla|cacerol|sart[eé]n|sartenes|acero inoxidable|cookware)/i.test(x.title||'')?3:0}))
                     .sort((a,b)=>a.availableForSale!==b.availableForSale?(a.availableForSale?-1:1):b._b-a._b).slice(0,6);
        } else if(/(mesa|vidrio).*(limpiar|mancha|grasa|sarro)/.test(qn)||/limpia\s*vidri/.test(qn)) items=(await searchProductsPlain('limpia vidrios',10)).slice(0,3);
        else if(/(lavalozas|lava loza|lavaplatos)/.test(qn)) items=(await searchProductsPlain('lavalozas',12)).slice(0,6);
        else if(/(parrilla|bbq|grill)/.test(qn)){ const pool=[]; for(const q of ['limpiador parrilla','goo gone bbq','desengrasante parrilla']) pool.push(...await searchProductsPlain(q,6)); items=pool.slice(0,6); }
        else { const bqs=bodyQueriesFromText(message||''), seen=new Set(), body=[]; for(const q of bqs){ const f=await searchProductsPlain(q,18).catch(()=>[]); for(const it of f){ if(seen.has(it.handle)) continue; seen.add(it.handle); body.push(it); if(body.length>=36) break; } if(body.length>=36) break; } items=body.slice(0,6); }
      }
      let tip=''; try{ const ai=await openai.chat.completions.create({model:'gpt-4o-mini',messages:[{role:'system',content:AI_POLICY},{role:'user',content:message||''}]}); tip=(ai.choices?.[0]?.message?.content||'').trim(); if(tip) tip=`TIP: ${tip}`; }catch{}
      const list=items?.length?`\n\n${buildProductsMarkdown(items)}`:'';
      const greet=(meta?.userFirstName&&meta?.tipAlreadyShown!==true&&Number(meta?.cartSubtotalCLP||0)<Number(FREE_TH||FREE_TH_DEFAULT))
        ? `TIP: Hola, ${meta.userFirstName} 👋 | Te faltan ${fmtCLP(Number(FREE_TH||FREE_TH_DEFAULT)-Number(meta?.cartSubtotalCLP||0))} para envío gratis en RM\n\n` : '';
      return res.json({text: tip?`${greet}${tip}${list}`:(list||'No encontré coincidencias exactas. ¿Me das una pista más (marca, superficie, aroma)?')});
    }

    return res.json({text:"¿Me cuentas un poco más? Puedo sugerirte productos o calcular envío por región."});
  }catch(e){ console.error(e); return res.status(500).json({error:String(e)}); }
});

/* Health */
app.get('/health',(_,res)=>res.json({ok:true}));
const port=PORT||process.env.PORT||3000; app.listen(port,()=>console.log('ML Chat server on :'+port));
