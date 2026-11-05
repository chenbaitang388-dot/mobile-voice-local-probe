/* Adapted from moyue23/rvc-web-runtime, MIT, commit
   bed1e46d1a4e0ba8a47dd13975a467e5e8c88d62
   packages/engine/src/model/sessionFactory.ts.
   Types/error dependency removed; error causes retained; caller chooses provider.
   Upstream copyright/license in RVC-LICENSE. */
window.createSessionFromOnnxBuffer=async function(onnxBuffer,options={}){
  const backends=Array.from(new Set(options.preferredBackends?.length?options.preferredBackends:['wasm']));
  let lastCause;
  for(const backend of backends){
    try{return {session:await ort.InferenceSession.create(onnxBuffer,{...options.sessionOptions,executionProviders:[backend]}),backend}}
    catch(cause){lastCause=cause}
  }
  throw new Error(`ONNX session failed for ${backends.join(', ')}: ${String(lastCause)}`);
};
