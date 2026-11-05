/* Explicit local caching only. No background sync, telemetry, or audio. */
const offlineStatus=document.getElementById('offline-status');
async function offlineMessage(type){
 if(!window.isSecureContext||!('serviceWorker' in navigator))throw new Error('unsupported');
 let registration=await navigator.serviceWorker.getRegistration(new URL('./',location.href));
 if(type==='SAVE'){
  registration=await navigator.serviceWorker.register('./sw.js',{scope:'./'});
  registration=await navigator.serviceWorker.ready;
 }
 const worker=registration?.active;
 if(!worker)return {ok:false,code:'not_saved'};
 return await new Promise((resolve,reject)=>{
  const channel=new MessageChannel();
  const timer=setTimeout(()=>{channel.port1.close();reject(new Error('timeout'))},120000);
  channel.port1.onmessage=e=>{clearTimeout(timer);channel.port1.close();resolve(e.data)};
  worker.postMessage({type},[channel.port2]);
 });
}
document.getElementById('save-offline').onclick=async()=>{
 const button=document.getElementById('save-offline');button.disabled=true;
 offlineStatus.textContent='正在保存本页必需的公开文件，约 22 MB。请保持页面打开。';
 try{const result=await offlineMessage('SAVE');offlineStatus.textContent=result.ok?'离线文件已完整保存。请在 iPhone 上断网、关闭并重新打开本页，再做测试。':'没有完成离线保存，请保持联网后重试。';window.offlineTestResult=result}
 catch{offlineStatus.textContent='离线保存失败。请检查 HTTPS、浏览器支持和可用存储；不要把本页当作已可离线使用。';window.offlineTestResult={ok:false,code:'save_failed'}}
 finally{button.disabled=false}
};
document.getElementById('check-offline').onclick=async()=>{
 try{const result=await offlineMessage('CHECK');offlineStatus.textContent=result.ok?'本页必需文件均在缓存中；仍请断网重新打开验证。':'离线文件尚未完整保存，请先联网点击保存。';window.offlineTestResult=result}
 catch{offlineStatus.textContent='无法确认离线文件，当前不能保证离线打开。';window.offlineTestResult={ok:false,code:'check_failed'}}
};
