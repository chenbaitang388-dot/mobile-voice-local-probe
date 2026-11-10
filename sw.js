/* Only this app's public, fixed file set. No uploads or background sync. */
const CACHE='baitang-public-probe-v3-components:'+self.registration.scope;
const FILES=['./','./index.html','./style.css','./probe.js','./session-factory.js','./report-export.js','./offline.js','./manifest.webmanifest','./icon.svg','./PRIVACY.txt','./THIRD_PARTY_NOTICES.txt','./runtime-manifest.json','./vendor/ort.webgpu.min.js','./vendor/ort-wasm-simd-threaded.jsep.mjs','./vendor/ort-wasm-simd-threaded.jsep.wasm','./vendor/LICENSE','./models/candidate_real_stft.onnx','./models/candidate_real_istft.onnx','./RVC-LICENSE','./SEED-LICENSE','./source/generate_spectral_models.py','./source/README.txt','./licenses/Apache-2.0.txt','./licenses/ORT-ThirdPartyNotices.txt'];
const URLS=FILES.map(file=>new URL(file,self.registration.scope).href);
// These optional files are online-only: never included in SAVE or prefetched.
const ONLINE_FILES=["./COMPONENT_NOTICES.txt", "./component-fixtures/dit-condition.f32", "./component-fixtures/dit-ort.f32", "./component-fixtures/dit-reference_mel.f32", "./component-fixtures/dit-source.f32", "./component-fixtures/dit-state.f32", "./component-fixtures/dit-style.f32", "./component-fixtures/dit-time.f32", "./component-fixtures/lr-features.f32", "./component-fixtures/lr-ort.f32", "./component-fixtures/lr-torchscript.f32", "./component-fixtures/manifest.json", "./component-models/dit.onnx", "./component-models/lr.onnx", "./component-report-export.js", "./components.html", "./components.js", "./source/seed_components/GPL-3.0.txt", "./source/seed_components/README.txt", "./source/seed_components/config.yml", "./source/seed_components/export_components.py", "./source/seed_components/model-card.md", "./source/seed_components/source-provenance.json", "./source/seed_components/upstream_seed/modules/commons.py", "./source/seed_components/upstream_seed/modules/diffusion_transformer.py", "./source/seed_components/upstream_seed/modules/encodec.py", "./source/seed_components/upstream_seed/modules/flow_matching.py", "./source/seed_components/upstream_seed/modules/length_regulator.py", "./source/seed_components/upstream_seed/modules/wavenet.py"];
const ONLINE_URLS=ONLINE_FILES.map(file=>new URL(file,self.registration.scope).href);
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
async function complete(cache){for(const url of URLS)if(!await cache.match(url))return false;return true}
let saving=null;
async function save(){
 const cache=await caches.open(CACHE);
 await cache.addAll(URLS.map(url=>new Request(url,{cache:'reload',credentials:'omit'})));
 return {ok:await complete(cache),code:'checked',files:URLS.length};
}
self.addEventListener('message',event=>{
 if(!['SAVE','CHECK'].includes(event.data?.type)||!event.ports[0])return;
 event.waitUntil((async()=>{
  try{
   let result;
   if(event.data.type==='SAVE'){if(!saving)saving=save().finally(()=>{saving=null});result=await saving}
   else result={ok:await complete(await caches.open(CACHE)),code:'checked',files:URLS.length};
   event.ports[0].postMessage(result);
  }catch{event.ports[0].postMessage({ok:false,code:'cache_failed'})}
 })());
});
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);const clean=url.origin+url.pathname;
 if(url.origin!==self.location.origin){event.respondWith(Promise.resolve(new Response('External request disabled',{status:403})));return}
 if(!clean.startsWith(self.registration.scope))return;
 if(event.request.method!=='GET'){event.respondWith(Promise.resolve(new Response('Read only',{status:405})));return}
 // The iPhone app has a separate worker and cache under its own scope.
 if(clean.startsWith(new URL('./iphone/',self.registration.scope).href))return;
 if(ONLINE_URLS.includes(clean)){event.respondWith(fetch(event.request));return}
 if(!URLS.includes(clean)){event.respondWith(Promise.resolve(new Response('Not in offline file list',{status:404})));return}
 event.respondWith((async()=>{
  const cached=await(await caches.open(CACHE)).match(clean);
  return cached||fetch(event.request);
 })());
});
