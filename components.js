/* Reuses the previously verified local component harness and ORT Web API.
   Models and fixtures are fetched only after an explicit matching button click. */
window.componentEvidence={runs:[]};
const get=id=>document.getElementById(id),display=(id,value)=>get(id).textContent=typeof value==='string'?value:JSON.stringify(value,null,2);
const lrPassedPolicies=new Set();let running=false,activeModelDownload=null;
function controls(){document.querySelectorAll('button,select').forEach(x=>x.disabled=running);get('dit').disabled=running||!lrPassedPolicies.has(get('provider').value);get('cancel-download').disabled=!activeModelDownload}
function safeFailure(error,phase){
 const text=String(error);let errorCategory='unknown';
 const downloadCodes=['download_cancelled','download_stalled','download_http','download_incomplete','download_oversize','download_invalid_size'];
 if(downloadCodes.includes(error?.downloadCode))errorCategory=error.downloadCode;
 else if(phase==='model-download'&&/Failed to fetch|Load failed|NetworkError|network connection|network error/i.test(text))errorCategory='download_network';
 else if(/WebGPU adapter unavailable|WebGPU requires a secure context/.test(text))errorCategory='gpu_unavailable';
 else if(/fallback to CPU EP has been explicitly disabled|assigned to the default CPU EP|disable_cpu_ep_fallback/i.test(text))errorCategory='cpu_assignment_rejected';
 else if(/Could not find an implementation|No Op registered|Unsupported operator|kernel not found/i.test(text))errorCategory='unsupported_operator';
 else if(/Fixture HTTP|Model HTTP|Fixture manifest unavailable/.test(text))errorCategory='artifact_unavailable';
 else if(/Fixture length mismatch|Model length mismatch/.test(text))errorCategory='artifact_invalid';
 else if(/out of memory|Failed to allocate/i.test(text))errorCategory='memory_allocation';
 else if(/shader compilation|WGSL.*error/i.test(text))errorCategory='shader_compilation';
 else if(/Numerical tolerance exceeded/.test(text))errorCategory='numeric_mismatch';
 const result={errorCategory,failurePhase:phase};
 if(['cpu_assignment_rejected','unsupported_operator'].includes(errorCategory)){
  const allowed=['Softplus','Mish','Shape','Reshape','Cast','Range','Resize','Conv','InstanceNormalization','MatMul','Gather','LayerNormalization','Add','Mul','Transpose','Unsqueeze','Concat','ReduceMax'];
  const found=allowed.find(op=>new RegExp('\\b'+op+'\\b').test(text));if(found)result.failureOperator=found;
 }
 return result;
}
function errors(actual,expected){
 if(actual.length!==expected.length)return {maxAbsoluteError:Infinity,rmsError:Infinity,finite:false};
 let max=0,sum=0,finite=true;for(let i=0;i<actual.length;i++){finite=finite&&Number.isFinite(actual[i]);const d=Math.abs(actual[i]-expected[i]);max=Math.max(max,d);sum+=d*d}
 return {maxAbsoluteError:max,rmsError:Math.sqrt(sum/actual.length),finite};
}
async function readFixture(spec){const response=await fetch('./component-fixtures/'+spec.path);if(!response.ok)throw new Error('Fixture HTTP '+response.status);const bytes=await response.arrayBuffer();if(bytes.byteLength!==spec.bytes)throw new Error('Fixture length mismatch');return new Float32Array(bytes)}
function downloadError(code){const error=new Error(code);error.downloadCode=code;return error}
async function downloadModel(spec,report){
 const expected=spec.modelBytes;
 report.modelExpectedBytes=expected;report.modelBytesReceived=0;report.modelDownloadComplete=false;
 if(!Number.isSafeInteger(expected)||expected<=0||expected>100*1024*1024)throw downloadError('download_invalid_size');
 const started=performance.now(),state={controller:new AbortController(),cancelled:false,stalled:false};
 activeModelDownload=state;controls();let reader,timer,lastPaint=-Infinity;
 const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>{state.stalled=true;state.controller.abort()},120000)};
 const paint=(force=false)=>{const now=performance.now();if(force||now-lastPaint>=200){lastPaint=now;display('state','下载当前模型：'+(report.modelBytesReceived/1e6).toFixed(1)+' / '+(expected/1e6).toFixed(1)+' MB（'+Math.floor(report.modelBytesReceived/expected*100)+'%）。请保持页面在前台；可取消后手动重试。')}};
 try{
  arm();paint(true);
  const response=await fetch(spec.model,{signal:state.controller.signal});report.modelHttpStatus=response.status;
  const rawLength=response.headers.get('content-length');const length=rawLength===null?NaN:Number(rawLength);if(Number.isSafeInteger(length)&&length>=0)report.modelResponseContentLength=length;
  if(!response.ok)throw downloadError('download_http');
  report.downloadProgressSupported=!!response.body?.getReader;
  let data;
  if(report.downloadProgressSupported){
   // One final-size allocation: do not retain all chunks and duplicate the model.
   const buffer=new Uint8Array(expected);reader=response.body.getReader();
   for(;;){
    const item=await reader.read();
    if(item.done)break;
    if(item.value.byteLength){arm();const received=report.modelBytesReceived+item.value.byteLength;report.modelBytesReceived=received;if(received>expected)throw downloadError('download_oversize');buffer.set(item.value,received-item.value.byteLength);paint()}
   }
   data=buffer.buffer;
  }else{data=await response.arrayBuffer();report.modelBytesReceived=data.byteLength}
  if(report.modelBytesReceived!==expected)throw downloadError('download_incomplete');
  report.modelDownloadComplete=true;report.modelFetchMs=performance.now()-started;paint(true);return data;
 }catch(error){
  if(['AbortError','TypeError','RangeError','NetworkError','Error'].includes(error?.name))report.downloadExceptionName=error.name;
  if(state.cancelled)throw downloadError('download_cancelled');
  if(state.stalled)throw downloadError('download_stalled');
  throw error;
 }finally{
  clearTimeout(timer);report.modelDownloadElapsedMs=performance.now()-started;report.downloadCancelled=state.cancelled;
  if(!report.modelDownloadComplete){state.controller.abort();if(reader)try{await reader.cancel()}catch{}}
  if(reader)try{reader.releaseLock()}catch{}
  if(activeModelDownload===state)activeModelDownload=null;controls();
 }
}
async function runComponent(name){
 if(running||!['lr','dit'].includes(name))return;
 const executionPolicy=get('provider').value,provider=executionPolicy==='wasm'?'wasm':'webgpu';if(name==='dit'&&!lrPassedPolicies.has(executionPolicy))return;
 running=true;controls();let session;const feeds={};
 let phase='prepare';
 const report={component:name,benchmarkVersion:5,executionPolicy,requestedProvider:provider,provider,providerFieldMeaning:'requested',requestedExecutionProviders:[provider],gpuStrict:executionPolicy==='gpu-strict',cpuFallbackAllowed:executionPolicy==='gpu-compatible',automaticCpuFallback:executionPolicy==='gpu-compatible',cpuFallbackActual:'not-exposed',nodeProviderAssignment:'not-exposed',wholeSessionCpuRetry:false,threads:1,passed:false,noAudioDevices:true,noServerInference:true,firstRunMayIncludeCompilation:true};
 try{
  if(!['wasm','gpu-compatible','gpu-strict'].includes(executionPolicy))throw new Error('Unsupported policy');
  phase='gpu-check';
  if(provider==='webgpu'){
   report.secureContext=window.isSecureContext;report.webGPUApi=!!navigator.gpu;
   if(!window.isSecureContext||!navigator.gpu)throw new Error('WebGPU requires a secure context and supported browser');
   report.webGPUAdapter=!!(await navigator.gpu.requestAdapter());if(!report.webGPUAdapter)throw new Error('WebGPU adapter unavailable; CPU fallback is disabled');
  }
  ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;ort.env.wasm.wasmPaths=new URL('./vendor/',location.href).href;
  phase='fixtures';const response=await fetch('./component-fixtures/manifest.json');if(!response.ok)throw new Error('Fixture manifest unavailable');
  const spec=(await response.json()).components[name];report.modelBytes=spec.modelBytes;report.runtimeVersion=ort.env.versions.web;
  display('state','读取合成测试数值');for(const [key,value] of Object.entries(spec.input))feeds[key]=new ort.Tensor('float32',await readFixture(value),value.shape);
  const expected=await readFixture(spec.expected),native=await readFixture(spec.nativeOrt);
  phase='model-download';const data=await downloadModel(spec,report);
  // Request only WebGPU in both GPU policies. Listing WASM as another backend
  // would let ORT drop a failed GPU backend entirely. CPU nodes are implicitly
  // permitted when the strict native flag is omitted; node placement is unknown.
  const sessionOptions=executionPolicy==='gpu-strict'?{extra:{session:{disable_cpu_ep_fallback:'1'}}}:{};report.cpuNodeFallbackDisabled=executionPolicy==='gpu-strict';
  phase='session-create';display('state','创建当前模型会话');const initialize=performance.now();const made=await createSessionFromOnnxBuffer(data,{preferredBackends:[provider],sessionOptions});session=made.session;report.sessionCreateMs=performance.now()-initialize;
  report.runsMs=[];report.warmRunMs=[];report.warmChecks=[];report.runChecks=[];
  for(let i=0;i<4;i++){
   phase='inference';display('state',i===0?'首次计算（可能包含编译开销）':'复用同一会话，预热计算 '+i+'/3');
   const start=performance.now(),outputs=await session.run(feeds);let result;
   try{result=new Float32Array(outputs[spec.output].data);report.outputShape=outputs[spec.output].dims}
   finally{for(const value of Object.values(outputs))if(value.dispose)value.dispose()}
   const elapsed=performance.now()-start;phase='validation';const check=errors(result,expected),nativeCheck=errors(result,native);
   const passed=check.finite&&check.maxAbsoluteError<spec.atol&&check.rmsError<spec.rmsTolerance;
   report.runsMs.push(elapsed);report.runChecks.push({...check,passed});
   if(i===0){report.firstRunMs=elapsed;report.versusExpected=check;report.versusNativeOrt=nativeCheck}
   else{report.warmRunMs.push(elapsed);report.warmChecks.push({...check,passed})}
   report.outputSamples=result.length;
   if(!passed)throw new Error('Numerical tolerance exceeded');
  }
  report.warmRunCount=report.warmRunMs.length;report.warmMedianMs=[...report.warmRunMs].sort((a,b)=>a-b)[1];report.passed=report.runChecks.length===4&&report.runChecks.every(item=>item.passed);
  if(name==='lr'&&report.passed)lrPassedPolicies.add(executionPolicy);
 }catch(error){report.passed=false;report.error=String(error);Object.assign(report,safeFailure(error,phase))}finally{
  report.sessionCreated=!!session;report.sessionReleased=false;
  if(session){try{await session.release();report.sessionReleased=true}catch{report.passed=false;report.error='Session release failed';report.errorCategory='session_release_failed';report.failurePhase='release'}}
  for(const input of Object.values(feeds))if(input.dispose)input.dispose();
  if(name==='lr'&&!report.passed)lrPassedPolicies.delete(executionPolicy);
  window.componentEvidence.runs.push(report);display('result',report);display('state',report.passed?'测试通过，模型会话已释放':'测试未通过；可复制结果反馈。详细错误只保留在本页。');running=false;controls();
 }
 return report;
}
get('lr').onclick=()=>runComponent('lr');get('dit').onclick=()=>runComponent('dit');get('cancel-download').onclick=()=>{if(activeModelDownload){activeModelDownload.cancelled=true;activeModelDownload.controller.abort()}};get('provider').onchange=controls;window.runComponent=runComponent;controls();
