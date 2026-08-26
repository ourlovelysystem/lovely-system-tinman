(()=>{
  const API=(window.TINMAN_CONFIG?.apiUrl||'').replace(/\/$/,'');
  const $=id=>document.getElementById(id);
  const mode=location.pathname.toLowerCase().includes('appeal')?'appeal':'message';
  let recorder=null,stream=null,chunks=[],blob=null,blobUrl='',startedAt=0,timer=0;
  let audioContext=null,analyser=null,meterFrame=0;

  if(!$('title')){
    const input=document.createElement('input');input.id='title';input.maxLength=120;input.placeholder='Optional recording title';
    const label=document.createElement('label');label.htmlFor='title';label.textContent='Title';
    $('selfId').after(label,input);
  }

  function notice(message,error=false){$('notice').textContent=message;$('notice').classList.toggle('error',error)}
  function format(seconds){seconds=Math.max(0,Math.floor(seconds||0));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`}
  function setElapsed(){
    const value=recorder?.state==='recording'?(Date.now()-startedAt)/1000:($('preview').currentTime||0);
    $('elapsed').textContent=format(value);
  }
  function previewReady(){
    $('preview').hidden=false;$('playButton').disabled=false;$('rewindButton').disabled=false;$('forwardButton').disabled=false;$('submitButton').disabled=false;
  }
  function drawIdleMeter(){
    const canvas=$('visualizer'),dpr=devicePixelRatio||1;
    canvas.width=Math.max(1,Math.floor(canvas.clientWidth*dpr));canvas.height=Math.max(1,Math.floor(canvas.clientHeight*dpr));
    const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,canvas.clientWidth,canvas.clientHeight);
    ctx.strokeStyle='#394248';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,canvas.clientHeight/2+.5);ctx.lineTo(canvas.clientWidth,canvas.clientHeight/2+.5);ctx.stroke();
  }
  function startMeter(sourceStream){
    audioContext=new (window.AudioContext||window.webkitAudioContext)();
    analyser=audioContext.createAnalyser();analyser.fftSize=256;analyser.smoothingTimeConstant=.72;
    audioContext.createMediaStreamSource(sourceStream).connect(analyser);
    const data=new Uint8Array(analyser.frequencyBinCount),canvas=$('visualizer'),ctx=canvas.getContext('2d');
    const draw=()=>{
      meterFrame=requestAnimationFrame(draw);analyser.getByteFrequencyData(data);
      const w=canvas.clientWidth,h=canvas.clientHeight,dpr=devicePixelRatio||1;
      if(canvas.width!==Math.floor(w*dpr)||canvas.height!==Math.floor(h*dpr)){canvas.width=Math.floor(w*dpr);canvas.height=Math.floor(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0)}
      ctx.fillStyle='#080a0b';ctx.fillRect(0,0,w,h);
      const bars=48,gap=3,barWidth=Math.max(2,(w-gap*(bars-1))/bars);
      for(let i=0;i<bars;i++){
        const value=data[Math.floor(i*data.length/bars)]/255,barHeight=Math.max(2,value*(h-12));
        ctx.fillStyle=value>.82?'#ff796f':value>.55?'#f1c75b':'#d7e0e4';
        ctx.fillRect(i*(barWidth+gap),(h-barHeight)/2,barWidth,barHeight);
      }
    };draw();
  }
  function stopMeter(){cancelAnimationFrame(meterFrame);meterFrame=0;analyser=null;if(audioContext){audioContext.close();audioContext=null}drawIdleMeter()}
  async function api(path,options={}){
    if(!API)throw new Error('API URL is not configured.');
    const response=await fetch(API+path,options);
    if(!response.ok)throw new Error((await response.text())||`Request failed: ${response.status}`);
    return response.status===204?null:response.json();
  }

  $('recordButton').onclick=async()=>{
    try{
      stream=await navigator.mediaDevices.getUserMedia({audio:true});
      const preferred=['audio/webm;codecs=opus','audio/mp4'].find(MediaRecorder.isTypeSupported)||'';
      recorder=new MediaRecorder(stream,preferred?{mimeType:preferred}:undefined);chunks=[];blob=null;
      if(blobUrl)URL.revokeObjectURL(blobUrl);
      recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
      recorder.onstop=()=>{
        blob=new Blob(chunks,{type:recorder.mimeType||'audio/webm'});blobUrl=URL.createObjectURL(blob);$('preview').src=blobUrl;previewReady();
        stream.getTracks().forEach(track=>track.stop());stream=null;$('recordingState').textContent='Recorded';setElapsed();
      };
      recorder.start();startedAt=Date.now();timer=setInterval(setElapsed,250);
      startMeter(stream);
      $('recordButton').disabled=true;$('stopButton').disabled=false;$('submitButton').disabled=true;$('preview').hidden=true;$('recordingState').textContent='Recording…';notice('Recording locally. Nothing has been submitted yet.');
    }catch(error){notice(`Microphone unavailable: ${error.message}`,true)}
  };
  $('stopButton').onclick=()=>{if(recorder?.state==='recording'){recorder.stop();stopMeter();clearInterval(timer);$('stopButton').disabled=true;$('recordButton').disabled=false}};
  $('playButton').onclick=()=>{$('preview').paused?$('preview').play():$('preview').pause()};
  $('rewindButton').onclick=()=>{$('preview').currentTime=Math.max(0,$('preview').currentTime-10)};
  $('forwardButton').onclick=()=>{$('preview').currentTime=Math.min($('preview').duration||0,$('preview').currentTime+10)};
  $('preview').ontimeupdate=setElapsed;

  $('submitButton').onclick=async()=>{
    const selfId=$('selfId').value.trim();
    if(!selfId)return notice('Self-identification is required.',true);
    if(!blob)return notice('Record a message first.',true);
    $('submitButton').disabled=true;notice('Submitting recording…');
    try{
      const duration=Math.round((Number.isFinite($('preview').duration)?$('preview').duration:0)*10)/10;
      const init=await api('/recordings/init',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({self_id:selfId,title:$('title').value.trim(),message_type:mode,content_type:blob.type||'audio/webm',duration_seconds:duration})});
      const upload=await fetch(init.upload_url,{method:'PUT',headers:{'content-type':blob.type||'audio/webm'},body:blob});
      if(!upload.ok)throw new Error(`Audio upload failed: ${upload.status}`);
      await api('/recordings/complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({recording_id:init.recording_id})});
      notice('Recording submitted.');blob=null;$('submitButton').disabled=true;await loadRecordings();
    }catch(error){notice(error.message,true);$('submitButton').disabled=false}
  };

  function escapeHtml(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  async function loadRecordings(){
    $('recordings').innerHTML='<p class="empty">Loading recordings…</p>';
    try{
      const data=await api(`/recordings?message_type=${encodeURIComponent(mode)}&limit=50`);
      $('recordings').innerHTML=data.items.length?data.items.map(item=>`<article class="recording"><div class="meta"><div><div class="recordingTitle">${escapeHtml(item.title||'Untitled recording')}</div><div class="who">${escapeHtml(item.self_id)}</div><div class="details">${escapeHtml(item.message_type)} · ${format(item.duration_seconds)}</div></div><time class="when">${new Date(item.created_at).toLocaleString()}</time></div><audio controls preload="none" src="${escapeHtml(item.play_url)}"></audio></article>`).join(''):'<p class="empty">No recordings have been submitted.</p>';
    }catch(error){$('recordings').innerHTML=`<p class="empty">Recording browser unavailable: ${escapeHtml(error.message)}</p>`}
  }
  $('refreshButton').onclick=loadRecordings;drawIdleMeter();addEventListener('resize',drawIdleMeter);loadRecordings();
})();
