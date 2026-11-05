/* Runtime API follows Microsoft's ORT Web examples. No microphone/audio output API. */
const byId=id=>document.getElementById(id);
window.probeEvidence={runs:[],limitations:['Not a complete voice model','No iPhone execution claimed until run on an actual iPhone','No microphone or playback requested']};
const show=(id,data)=>{byId(id).textContent=JSON.stringify(data,null,2)};
async function capabilities(){
  const data={secureContext:window.isSecureContext,webAssembly:typeof WebAssembly==='object',webGPU:!!navigator.gpu,audioWorklet:'AudioWorkletNode' in window,crossOriginIsolated:window.crossOriginIsolated,onnxRuntime:ort.env.versions.web};
  if(navigator.gpu){try{const adapter=await navigator.gpu.requestAdapter();data.webGPUAdapter=!!adapter}catch(e){data.webGPUAdapterError=String(e)}}
  window.probeEvidence.capabilities=data;show('caps',data);return data;
}
async function run(provider){
  const buttons=document.querySelectorAll('button');buttons.forEach(b=>b.disabled=true);
  const report={provider,requestedProvider:provider,benchmarkVersion:2,model:'Existing real-valued HiFT STFT/ISTFT operator pair',inputSamples:256,noAudioDevices:true,noServerInference:true,automaticCpuFallback:false,firstRunMayIncludeCompilation:true};
  let stft,istft;
  try{
    const caps=await capabilities();if(provider==='webgpu'&&!caps.webGPUAdapter)throw new Error('No WebGPU adapter available');
    ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;ort.env.wasm.wasmPaths=new URL('./vendor/',location.href).href;
    show('result',{state:'加载本地运行库与小模型',provider});
    const t=performance.now();
    const sessionOptions=provider==='webgpu'?{extra:{session:{disable_cpu_ep_fallback:'1'}}}:{};report.cpuNodeFallbackDisabled=provider==='webgpu';
    const first=await createSessionFromOnnxBuffer(await(await fetch('./models/candidate_real_stft.onnx')).arrayBuffer(),{preferredBackends:[provider],sessionOptions});stft=first.session;
    const second=await createSessionFromOnnxBuffer(await(await fetch('./models/candidate_real_istft.onnx')).arrayBuffer(),{preferredBackends:[provider],sessionOptions});istft=second.session;
    report.createdSessionBackends=[first.backend,second.backend];report.sessionLoadMs=performance.now()-t;
    const wave=Float32Array.from({length:256},(_,i)=>0.1*Math.sin(i*2*Math.PI*7/256)+0.025*Math.cos(i*2*Math.PI*19/256));
    async function runPair(){
      const start=performance.now();const spectra=await stft.run({wave:new ort.Tensor('float32',wave,[1,256])});
      const real=spectra.real.data,imag=spectra.imag.data;
      const magnitude=Float32Array.from(real,(r,i)=>Math.hypot(r,imag[i]));const phase=Float32Array.from(real,(r,i)=>Math.atan2(imag[i],r));
      const output=await istft.run({magnitude:new ort.Tensor('float32',magnitude,[1,9,65]),phase:new ort.Tensor('float32',phase,[1,9,65])});
      const restored=output.wave.data;const ms=performance.now()-start;let max=0,sum=0;
      for(let i=0;i<wave.length;i++){const error=Math.abs(restored[i]-wave[i]);max=Math.max(max,error);sum+=error*error}
      return {ms,outputSamples:restored.length,maxAbsoluteError:max,rmsError:Math.sqrt(sum/wave.length),passed:restored.length===256&&Number.isFinite(max)&&max<1e-5};
    }
    const initial=await runPair();
    report.firstRunMs=initial.ms;report.operatorPairMs=initial.ms;
    report.outputSamples=initial.outputSamples;report.maxAbsoluteError=initial.maxAbsoluteError;report.rmsError=initial.rmsError;
    report.warmRunMs=[];report.warmChecks=[];
    for(let i=0;i<5;i++){
      const result=await runPair();report.warmRunMs.push(result.ms);
      report.warmChecks.push({passed:result.passed,maxAbsoluteError:result.maxAbsoluteError,rmsError:result.rmsError});
    }
    report.warmRunCount=report.warmRunMs.length;report.warmMedianMs=[...report.warmRunMs].sort((a,b)=>a-b)[2];
    report.passed=initial.passed&&report.warmChecks.every(result=>result.passed);
    report.scope='Only the requested backend is allowed; WebGPU uses disable_cpu_ep_fallback=1. Still not a whole voice-model or mobile latency benchmark.';
  }catch(error){report.passed=false;report.error=String(error)}finally{
    if(stft)await stft.release();if(istft)await istft.release();window.probeEvidence.runs.push(report);show('result',report);buttons.forEach(b=>b.disabled=false);
  }
  return report;
}
byId('inspect').onclick=capabilities;byId('wasm').onclick=()=>run('wasm');byId('gpu').onclick=()=>run('webgpu');
window.runProbe=run;
