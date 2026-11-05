/* Explicit user-click export only. Strict typed allowlist: never copy free-text
   errors, URLs, local paths, stack traces, unknown fields or raw user agents. */
function exportNumber(value){return typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e12?value:undefined}
function copyNumbers(source,target,keys){for(const key of keys){const value=exportNumber(source?.[key]);if(value!==undefined)target[key]=value}}
function copyBooleans(source,target,keys){for(const key of keys)if(typeof source?.[key]==='boolean')target[key]=source[key]}
function exportProvider(value){return ['wasm','webgpu'].includes(value)?value:'unknown'}
function exportMetrics(source){const output={};copyNumbers(source,output,['maxAbsoluteError','rmsError']);copyBooleans(source,output,['finite']);return output}
function sanitizedReport(evidence,platform,secureContext){
 const capabilities={};copyBooleans(evidence?.capabilities,capabilities,['secureContext','webAssembly','webGPU','audioWorklet','crossOriginIsolated','webGPUAdapter']);
 const output={schema:'baitang-synthetic-probe-v1',browserReportedPlatform:['Win32','Linux x86_64','MacIntel','iPhone','iPad'].includes(platform)?platform:'other',secureContext:secureContext===true,phoneVerified:false,deviceVerification:'not-automatically-verified',capabilities,runs:[]};
 for(const run of (Array.isArray(evidence?.runs)?evidence.runs:[]).slice(0,20)){
  const row={component:['lr','dit','euler'].includes(run?.component)?run.component:'small-graph',provider:exportProvider(run?.provider)};
  if(['gpu-compatible','gpu-strict','wasm'].includes(run?.executionPolicy))row.executionPolicy=run.executionPolicy;
  copyBooleans(run,row,['gpuStrict','cpuFallbackAllowed','wholeSessionCpuRetry']);
  if(run?.providerFieldMeaning==='requested')row.providerFieldMeaning='requested';
  if(run?.nodeProviderAssignment==='not-exposed')row.nodeProviderAssignment='not-exposed';
  if(run?.cpuFallbackActual==='not-exposed')row.cpuFallbackActual='not-exposed';
  if(Array.isArray(run?.requestedExecutionProviders))row.requestedExecutionProviders=run.requestedExecutionProviders.slice(0,2).filter(x=>['webgpu','wasm'].includes(x));
  if(['unknown','gpu_unavailable','cpu_assignment_rejected','unsupported_operator','artifact_unavailable','artifact_invalid','memory_allocation','shader_compilation','numeric_mismatch','session_release_failed','download_cancelled','download_stalled','download_http','download_incomplete','download_oversize','download_invalid_size','download_network'].includes(run?.errorCategory))row.errorCategory=run.errorCategory;
  if(['prepare','gpu-check','fixtures','model-download','session-create','inference','validation','release'].includes(run?.failurePhase))row.failurePhase=run.failurePhase;
  if(['Softplus','Mish','Shape','Reshape','Cast','Range','Resize','Conv','InstanceNormalization','MatMul','Gather','LayerNormalization','Add','Mul','Transpose','Unsqueeze','Concat','ReduceMax'].includes(run?.failureOperator))row.failureOperator=run.failureOperator;
  copyBooleans(run,row,['passed','automaticCpuFallback','cpuNodeFallbackDisabled','sessionCreated','sessionReleased','referencePrefixZero','webGPUAdapter','webGPUApi','secureContext','noAudioDevices','noServerInference','firstRunMayIncludeCompilation']);
  copyNumbers(run,row,['threads','modelBytes','inputSamples','outputSamples','modelFetchMs','sessionCreateMs','sessionLoadMs','operatorPairMs','inferenceSumMs','tenStepComputeAndScheduleMs','maxAbsoluteError','rmsError','benchmarkVersion','firstRunMs','warmMedianMs','warmRunCount']);
  copyNumbers(run,row,['modelExpectedBytes','modelBytesReceived','modelHttpStatus','modelResponseContentLength','modelDownloadElapsedMs']);
  copyBooleans(run,row,['modelDownloadComplete','downloadProgressSupported','downloadCancelled']);
  if(['AbortError','TypeError','RangeError','NetworkError','Error'].includes(run?.downloadExceptionName))row.downloadExceptionName=run.downloadExceptionName;
  if(Array.isArray(run?.warmRunMs))row.warmRunMs=run.warmRunMs.slice(0,5).map(exportNumber).filter(x=>x!==undefined);
  if(Array.isArray(run?.warmChecks))row.warmChecks=run.warmChecks.slice(0,5).map(check=>{const item=exportMetrics(check);copyBooleans(check,item,['passed']);return item});
  if(run?.requestedProvider!==undefined)row.requestedProvider=exportProvider(run.requestedProvider);
  if(run?.createdBackend!==undefined)row.createdBackend=exportProvider(run.createdBackend);
  if(Array.isArray(run?.createdSessionBackends))row.createdSessionBackends=run.createdSessionBackends.slice(0,2).map(exportProvider);
  if(typeof run?.runtimeVersion==='string'&&/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(run.runtimeVersion))row.runtimeVersion=run.runtimeVersion;
  if(Array.isArray(run?.runsMs))row.runsMs=run.runsMs.slice(0,10).map(exportNumber).filter(x=>x!==undefined);
  if(Array.isArray(run?.outputShape))row.outputShape=run.outputShape.slice(0,8).filter(x=>Number.isInteger(x)&&x>=0&&x<=1e9);
  if(run?.versusExpected)row.versusExpected=exportMetrics(run.versusExpected);
  if(run?.versusNativeOrt)row.versusNativeOrt=exportMetrics(run.versusNativeOrt);
  if(Array.isArray(run?.perStep))row.perStep=run.perStep.slice(0,10).map(step=>{const item={};copyNumbers(step,item,['step','time','dt','inferenceMs']);return item});
  if(run?.passed===false)row.failureCode=(run?.webGPUAdapter===false||capabilities.webGPUAdapter===false)&&row.provider==='webgpu'?'gpu_unavailable':'test_failed';
  if(run?.passed===false)row.failureHint='详细错误仅留在本机页面；导出已移除自由文本。';
  output.runs.push(row);
 }
 return output;
}
function reportText(){
 const evidence=window.componentEvidence||window.probeEvidence||{};
 return JSON.stringify({reportCreatedAt:new Date().toISOString(),...sanitizedReport(evidence,navigator.platform,window.isSecureContext)},null,2);
}
function revealReport(){const field=document.getElementById('report-text');field.value=reportText();field.hidden=false;field.focus();field.select();document.getElementById('copy-status').textContent='结果仅在本页显示。可长按文本复制，再自行发送。';return field.value}
document.getElementById('show-report').onclick=revealReport;
document.getElementById('copy-report').onclick=async()=>{
 const status=document.getElementById('copy-status');
 try{if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');await navigator.clipboard.writeText(reportText());status.textContent='已复制检查结果；没有上传。请自行粘贴发送。'}
 catch{revealReport();status.textContent='浏览器未允许直接复制；请长按下方文本手动复制。没有上传。'}
};
