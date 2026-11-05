/* Reuses the previously verified local component harness and ORT Web API.
   Models and fixtures are fetched only after an explicit matching button click. */
window.componentEvidence={runs:[]};
const get=id=>document.getElementById(id),display=(id,value)=>get(id).textContent=typeof value==='string'?value:JSON.stringify(value,null,2);
const lrPassedProviders=new Set();let running=false;
function controls(){document.querySelectorAll('button,select').forEach(x=>x.disabled=running);get('dit').disabled=running||!lrPassedProviders.has(get('provider').value)}
function errors(actual,expected){
 if(actual.length!==expected.length)return {maxAbsoluteError:Infinity,rmsError:Infinity,finite:false};
 let max=0,sum=0,finite=true;for(let i=0;i<actual.length;i++){finite=finite&&Number.isFinite(actual[i]);const d=Math.abs(actual[i]-expected[i]);max=Math.max(max,d);sum+=d*d}
 return {maxAbsoluteError:max,rmsError:Math.sqrt(sum/actual.length),finite};
}
async function readFixture(spec){const response=await fetch('./component-fixtures/'+spec.path);if(!response.ok)throw new Error('Fixture HTTP '+response.status);const bytes=await response.arrayBuffer();if(bytes.byteLength!==spec.bytes)throw new Error('Fixture length mismatch');return new Float32Array(bytes)}
async function runComponent(name){
 if(running||!['lr','dit'].includes(name))return;
 const provider=get('provider').value;if(name==='dit'&&!lrPassedProviders.has(provider))return;
 running=true;controls();let session;const feeds={};
 const report={component:name,benchmarkVersion:3,requestedProvider:provider,provider,threads:1,passed:false,automaticCpuFallback:false,noAudioDevices:true,noServerInference:true,firstRunMayIncludeCompilation:true};
 try{
  if(!['wasm','webgpu'].includes(provider))throw new Error('Unsupported provider');
  if(provider==='webgpu'){
   report.secureContext=window.isSecureContext;report.webGPUApi=!!navigator.gpu;
   if(!window.isSecureContext||!navigator.gpu)throw new Error('WebGPU requires a secure context and supported browser');
   report.webGPUAdapter=!!(await navigator.gpu.requestAdapter());if(!report.webGPUAdapter)throw new Error('WebGPU adapter unavailable; CPU fallback is disabled');
  }
  ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;ort.env.wasm.wasmPaths=new URL('./vendor/',location.href).href;
  const response=await fetch('./component-fixtures/manifest.json');if(!response.ok)throw new Error('Fixture manifest unavailable');
  const spec=(await response.json()).components[name];report.modelBytes=spec.modelBytes;report.runtimeVersion=ort.env.versions.web;
  display('state','读取合成测试数值');for(const [key,value] of Object.entries(spec.input))feeds[key]=new ort.Tensor('float32',await readFixture(value),value.shape);
  const expected=await readFixture(spec.expected),native=await readFixture(spec.nativeOrt);
  display('state','下载当前模型；不加载另一项');const load=performance.now(),modelResponse=await fetch(spec.model);if(!modelResponse.ok)throw new Error('Model HTTP '+modelResponse.status);
  const data=await modelResponse.arrayBuffer();if(data.byteLength!==spec.modelBytes)throw new Error('Model length mismatch');report.modelFetchMs=performance.now()-load;
  const sessionOptions=provider==='webgpu'?{extra:{session:{disable_cpu_ep_fallback:'1'}}}:{};report.cpuNodeFallbackDisabled=provider==='webgpu';
  display('state','创建当前模型会话');const initialize=performance.now();const made=await createSessionFromOnnxBuffer(data,{preferredBackends:[provider],sessionOptions});session=made.session;report.createdBackend=made.backend;report.sessionCreateMs=performance.now()-initialize;
  report.runsMs=[];report.warmRunMs=[];report.warmChecks=[];report.runChecks=[];
  for(let i=0;i<4;i++){
   display('state',i===0?'首次计算（可能包含编译开销）':'复用同一会话，预热计算 '+i+'/3');
   const start=performance.now(),outputs=await session.run(feeds);let result;
   try{result=new Float32Array(outputs[spec.output].data);report.outputShape=outputs[spec.output].dims}
   finally{for(const value of Object.values(outputs))if(value.dispose)value.dispose()}
   const elapsed=performance.now()-start,check=errors(result,expected),nativeCheck=errors(result,native);
   const passed=check.finite&&check.maxAbsoluteError<spec.atol&&check.rmsError<spec.rmsTolerance;
   report.runsMs.push(elapsed);report.runChecks.push({...check,passed});
   if(i===0){report.firstRunMs=elapsed;report.versusExpected=check;report.versusNativeOrt=nativeCheck}
   else{report.warmRunMs.push(elapsed);report.warmChecks.push({...check,passed})}
   report.outputSamples=result.length;
   if(!passed)throw new Error('Numerical tolerance exceeded');
  }
  report.warmRunCount=report.warmRunMs.length;report.warmMedianMs=[...report.warmRunMs].sort((a,b)=>a-b)[1];report.passed=report.runChecks.length===4&&report.runChecks.every(item=>item.passed);
  if(name==='lr'&&report.passed)lrPassedProviders.add(provider);
 }catch(error){report.passed=false;report.error=String(error)}finally{
  report.sessionCreated=!!session;report.sessionReleased=false;
  if(session){try{await session.release();report.sessionReleased=true}catch{report.passed=false;report.error='Session release failed'}}
  for(const input of Object.values(feeds))if(input.dispose)input.dispose();
  if(name==='lr'&&!report.passed)lrPassedProviders.delete(provider);
  window.componentEvidence.runs.push(report);display('result',report);display('state',report.passed?'测试通过，模型会话已释放':'测试未通过；可复制结果反馈。详细错误只保留在本页。');running=false;controls();
 }
 return report;
}
get('lr').onclick=()=>runComponent('lr');get('dit').onclick=()=>runComponent('dit');get('provider').onchange=controls;window.runComponent=runComponent;controls();
