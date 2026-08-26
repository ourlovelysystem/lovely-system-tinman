(()=>{
  const API=(window.TINMAN_CONFIG?.apiUrl||'').replace(/\/$/,'');
  const $=id=>document.getElementById(id);
  const mode=location.pathname.toLowerCase().includes('appeal')?'appeal':'message';
  let recorder=null,stream=null,chunks=[],blob=null,blobUrl='',startedAt=0,timer=0;
  let audioContext=null,analyser=null,meterFrame=0,meterOwner=null;
  let playbackContext=null,playbackAnalyser=null,playbackFrame=0,currentPlayback=null;
  const playbackSources=new WeakMap();
  let responseSession=null,interleavedPlayback=null;
  const responseIndex=new Map();
  let recordingResults=[];

  function responseNotice(id,message,error=false){
    const node=document.querySelector(`[data-response-notice="${CSS.escape(id)}"]`);
    if(node){node.textContent=message;node.classList.toggle('error',error)}
  }

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
  function sizeCanvas(canvas){
    const dpr=devicePixelRatio||1;
    canvas.width=Math.max(1,Math.floor(canvas.clientWidth*dpr));canvas.height=Math.max(1,Math.floor(canvas.clientHeight*dpr));
    const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);return ctx;
  }
  function drawIdle(canvas){
    const ctx=sizeCanvas(canvas);ctx.clearRect(0,0,canvas.clientWidth,canvas.clientHeight);
    ctx.strokeStyle='#394248';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,canvas.clientHeight/2+.5);ctx.lineTo(canvas.clientWidth,canvas.clientHeight/2+.5);ctx.stroke();
  }
  function drawIdleMeter(){drawIdle($('micVisualizer'));drawIdle($('playVisualizer'))}
  function drawAnalyser(canvas,meter,getFrame,setFrame){
    const data=new Uint8Array(meter.frequencyBinCount),ctx=canvas.getContext('2d');
    const draw=()=>{
      setFrame(requestAnimationFrame(draw));meter.getByteFrequencyData(data);
      const w=canvas.clientWidth,h=canvas.clientHeight,dpr=devicePixelRatio||1;
      if(canvas.width!==Math.floor(w*dpr)||canvas.height!==Math.floor(h*dpr)){canvas.width=Math.floor(w*dpr);canvas.height=Math.floor(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0)}
      ctx.fillStyle='#080a0b';ctx.fillRect(0,0,w,h);
      const bars=36,gap=3,barWidth=Math.max(2,(w-gap*(bars-1))/bars);
      for(let i=0;i<bars;i++){const value=data[Math.floor(i*data.length/bars)]/255,barHeight=Math.max(2,value*(h-10));ctx.fillStyle=value>.82?'#ff796f':value>.55?'#f1c75b':'#d7e0e4';ctx.fillRect(i*(barWidth+gap),(h-barHeight)/2,barWidth,barHeight)}
    };draw();
  }
  function startMeter(sourceStream,owner,label){
    if(audioContext){cancelAnimationFrame(meterFrame);audioContext.close();audioContext=null}
    meterOwner=owner;$('micMeterMode').textContent=label;
    audioContext=new (window.AudioContext||window.webkitAudioContext)();
    analyser=audioContext.createAnalyser();analyser.fftSize=256;analyser.smoothingTimeConstant=.72;
    audioContext.createMediaStreamSource(sourceStream).connect(analyser);
    drawAnalyser($('micVisualizer'),analyser,()=>meterFrame,value=>meterFrame=value);
  }
  function stopMeter(owner){
    if(owner&&meterOwner!==owner)return;cancelAnimationFrame(meterFrame);meterFrame=0;analyser=null;
    if(audioContext){audioContext.close();audioContext=null}
    meterOwner=null;$('micMeterMode').textContent='Ready';drawIdle($('micVisualizer'));
  }
  function startPlaybackMeter(audio){
    try{
      if(!playbackContext){playbackContext=new (window.AudioContext||window.webkitAudioContext)();playbackAnalyser=playbackContext.createAnalyser();playbackAnalyser.fftSize=256;playbackAnalyser.smoothingTimeConstant=.72;playbackAnalyser.connect(playbackContext.destination)}
      if(!playbackSources.has(audio)){const source=playbackContext.createMediaElementSource(audio);source.connect(playbackAnalyser);playbackSources.set(audio,source)}
      playbackContext.resume();currentPlayback=audio;cancelAnimationFrame(playbackFrame);$('playMeterMode').textContent='Playing';
      drawAnalyser($('playVisualizer'),playbackAnalyser,()=>playbackFrame,value=>playbackFrame=value);
    }catch(error){$('playMeterMode').textContent='Unavailable';drawIdle($('playVisualizer'))}
  }
  function stopPlaybackMeter(audio,state='Ready'){
    if(currentPlayback!==audio)return;cancelAnimationFrame(playbackFrame);playbackFrame=0;currentPlayback=null;$('playMeterMode').textContent=state;drawIdle($('playVisualizer'));
  }
  document.addEventListener('play',event=>{if(event.target instanceof HTMLAudioElement)startPlaybackMeter(event.target)},true);
  document.addEventListener('pause',event=>{if(event.target instanceof HTMLAudioElement&&!event.target.ended)stopPlaybackMeter(event.target,'Paused')},true);
  document.addEventListener('ended',event=>{if(event.target instanceof HTMLAudioElement)stopPlaybackMeter(event.target)},true);

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
      startMeter(stream,'message','Recording message');
      $('recordButton').disabled=true;$('stopButton').disabled=false;$('submitButton').disabled=true;$('preview').hidden=true;$('recordingState').textContent='Recording…';notice('Recording locally. Nothing has been submitted yet.');
    }catch(error){notice(`Microphone unavailable: ${error.message}`,true)}
  };
  $('stopButton').onclick=()=>{if(recorder?.state==='recording'){recorder.stop();stopMeter('message');clearInterval(timer);$('stopButton').disabled=true;$('recordButton').disabled=false}};
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
  function transcriptMarkup(item,transcript){
    if(!transcript||transcript.status==='locked')return `<div class="column-label">Written transcript</div><button class="unlock-transcript" data-unlock-transcript="${escapeHtml(item.recording_id)}">Unlock transcript</button>`;
    if(transcript.status==='processing')return '<div class="column-label">Written transcript</div><p class="transcript-state">Transcribing…</p>';
    if(transcript.status==='failed')return `<div class="column-label">Written transcript</div><p class="transcript-state error">Transcription failed.</p><button class="unlock-transcript" data-unlock-transcript="${escapeHtml(item.recording_id)}">Try again</button>`;
    const parts=(transcript.parts||[]).map(part=>`<p class="transcript-part ${part.role}"><strong>${escapeHtml(part.speaker)}</strong><span>${escapeHtml(part.text)}</span></p>`).join('');
    return `<div class="column-label">Written transcript</div>${transcript.status==='stale'?'<p class="transcript-state">New responses are not included.</p>':''}<div class="transcript-parts">${parts||'<p class="empty">No speech detected.</p>'}</div>${transcript.status==='stale'?`<button class="unlock-transcript" data-unlock-transcript="${escapeHtml(item.recording_id)}">Update transcript</button>`:''}`;
  }

  function responseMarkup(item,responses,transcript){
    responses.forEach(reply=>responseIndex.set(reply.response_id,reply));
    const responseCards=responses.length?responses.map(reply=>`
      <article class="reply-card ${reply.is_short?'short-response':''} ${reply.speaks_for_our_lovely_system?'system-speaker':''}">
        <div class="reply-meta">
          <div><strong>${escapeHtml(reply.self_id)}</strong><span>${format(reply.duration_seconds)} spoken</span></div>
          ${reply.speaks_for_our_lovely_system?'<span class="system-speaker-badge" title="This responder says: I speak for Our Lovely System." aria-label="Declared speaker for Our Lovely System">🫀</span>':''}
          ${reply.requests_additional_information?'<span class="inquiry-badge" title="This response appears to request additional information." aria-label="Question or information request detected">🔎</span>':''}
          ${reply.possible_sensitive_information?'<span class="sensitive-badge" title="Possible sensitive information detected. Audio and transcript are unchanged." aria-label="Possible sensitive information detected">⚠️</span>':''}
          ${reply.contains_quarantine?'<span class="quarantine-badge" title="Keyword detected: quarantine" aria-label="Quarantine keyword detected">☣️</span>':''}
          ${reply.is_short?'<span class="duration-verdict" title="Response does not exceed the original recording" aria-label="Response does not exceed the original recording">👎</span>':''}
        </div>
        <button class="interleaved-button primary" data-play-interleaved="${escapeHtml(reply.response_id)}">▶ Play interleaved result</button>
      </article>`).join(''):'<p class="empty response-empty">No audio responses yet.</p>';
    return `<article class="thread" data-recording-id="${escapeHtml(item.recording_id)}">
      <div class="thread-grid">
        <section class="thread-cell original-cell">
          <div class="column-label">Original <span class="original-flags">${item.requests_additional_information?'<span class="inquiry-badge" title="This message appears to request additional information." aria-label="Question or information request detected">🔎</span>':''}${item.possible_sensitive_information?'<span class="sensitive-badge" title="Possible sensitive information detected. Audio and transcript are unchanged." aria-label="Possible sensitive information detected">⚠️</span>':''}${item.contains_quarantine?'<span class="quarantine-badge" title="Keyword detected: quarantine" aria-label="Quarantine keyword detected">☣️</span>':''}</span></div>
          <div class="meta"><div><div class="recordingTitle">${escapeHtml(item.title||'Untitled recording')}</div><div class="who">${escapeHtml(item.self_id)}</div><div class="details">${escapeHtml(item.message_type)} · ${format(item.duration_seconds)}</div></div><time class="when">${new Date(item.created_at).toLocaleString()}</time></div>
          <audio class="source-audio" controls preload="none" crossorigin="anonymous" src="${escapeHtml(item.play_url)}"></audio>
        </section>
        <section class="thread-cell response-cell">
          <div class="column-label">Audio responses</div>
          <div class="response-list">${responseCards}</div>
          <button class="respond-button" data-respond-to="${escapeHtml(item.recording_id)}">Insert spoken response</button>
          <div class="response-composer" data-composer="${escapeHtml(item.recording_id)}" hidden>
            <label>Public self-identification<input class="response-self-id" maxlength="80" placeholder="How should this response identify you?"></label>
            <div class="response-controls">
              <button class="comment-button primary" aria-label="Hold to annotate the original recording">Hold to annotate</button>
              <button class="submit-response-button" disabled>Submit response</button>
            </div>
            <div class="response-status"><span>Play the original. Hold to annotate; release to continue.</span><span class="response-duration">0:00</span></div>
            <p class="response-notice" data-response-notice="${escapeHtml(item.recording_id)}" role="status"></p>
          </div>
        </section>
        <section class="thread-cell transcript-cell">${transcriptMarkup(item,transcript)}</section>
      </div>
    </article>`;
  }

  async function getResponses(recordingId){
    try{return (await api(`/responses?recording_id=${encodeURIComponent(recordingId)}`)).items||[]}
    catch(_){return []}
  }
  async function getTranscript(recordingId){
    try{return await api(`/transcripts?recording_id=${encodeURIComponent(recordingId)}`)}
    catch(_){return {status:'locked'}}
  }
  async function unlockTranscript(recordingId,button){
    button.disabled=true;button.textContent='Starting…';
    try{await api('/transcripts/unlock',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({recording_id:recordingId})});await loadRecordings()}
    catch(error){button.disabled=false;button.textContent='Try again';}
  }

  function closeResponseSession(){
    if(!responseSession)return;
    if(responseSession.recorder?.state==='recording')responseSession.recorder.stop();
    responseSession.stream?.getTracks().forEach(track=>track.stop());
    responseSession=null;
  }

  async function openResponseComposer(recordingId){
    if(responseSession&&responseSession.recordingId!==recordingId)closeResponseSession();
    const thread=document.querySelector(`[data-recording-id="${CSS.escape(recordingId)}"]`);
    const composer=thread.querySelector('.response-composer');
    composer.hidden=!composer.hidden;
    if(composer.hidden)return;
    const source=thread.querySelector('.source-audio');
    responseSession={recordingId,thread,composer,source,recorder:null,stream:null,clips:[],spokenMs:0,commentStarted:0,commentAnchor:0};
    responseNotice(recordingId,'Play the original. Insert a comment wherever you want to answer.');
  }

  async function startResponseComment(session){
    try{
      if(!session.stream)session.stream=await navigator.mediaDevices.getUserMedia({audio:true});
      const preferred=['audio/webm;codecs=opus','audio/mp4'].find(MediaRecorder.isTypeSupported)||'';
      session.recorder=new MediaRecorder(session.stream,preferred?{mimeType:preferred}:undefined);
      session.pendingChunks=[];
      session.recorder.ondataavailable=e=>{if(e.data.size)session.pendingChunks.push(e.data)};
      session.source.pause();
      session.commentAnchor=Math.round((session.source.currentTime||0)*10)/10;
      session.commentStarted=Date.now();
      if(!session.holdActive)return;
      session.recorder.start();
      startMeter(session.stream,'annotation','Annotating response');
      const holdButton=session.composer.querySelector('.comment-button');
      holdButton.classList.add('annotating');holdButton.textContent='Release to continue';
      responseNotice(session.recordingId,`Annotating at ${format(session.commentAnchor)}…`);
    }catch(error){responseNotice(session.recordingId,`Microphone unavailable: ${error.message}`,true)}
  }

  async function stopResponseComment(session){
    if(!session.recorder||session.recorder.state!=='recording')return;
    const durationMs=Date.now()-session.commentStarted;
    const stopped=new Promise(resolve=>session.recorder.addEventListener('stop',resolve,{once:true}));
    session.recorder.stop();await stopped;
    const clip=new Blob(session.pendingChunks,{type:session.recorder.mimeType||'audio/webm'});
    session.clips.push({blob:clip,anchor_seconds:session.commentAnchor,duration_seconds:Math.round(durationMs/100)/10});
    session.spokenMs+=durationMs;session.recorder=null;
    session.composer.querySelector('.response-duration').textContent=format(session.spokenMs/1000);
    stopMeter('annotation');
    const holdButton=session.composer.querySelector('.comment-button');
    holdButton.classList.remove('annotating');holdButton.textContent='Hold to annotate';
    session.composer.querySelector('.submit-response-button').disabled=false;
    responseNotice(session.recordingId,'Annotation inserted. Continuing the original.');
    session.source.play().catch(()=>{});
  }

  async function submitResponse(session){
    const selfId=session.composer.querySelector('.response-self-id').value.trim();
    if(!selfId)return responseNotice(session.recordingId,'Self-identification is required.',true);
    if(session.recorder?.state==='recording')await stopResponseComment(session);
    if(!session.clips.length)return responseNotice(session.recordingId,'Insert at least one spoken comment.',true);
    session.composer.querySelector('.submit-response-button').disabled=true;
    responseNotice(session.recordingId,'Preparing interleaved response…');
    try{
      const duration=Math.round(session.spokenMs/100)/10;
      const segments=session.clips.map(clip=>({anchor_seconds:clip.anchor_seconds,duration_seconds:clip.duration_seconds,content_type:clip.blob.type||'audio/webm'}));
      const init=await api('/responses/init',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({recording_id:session.recordingId,self_id:selfId,duration_seconds:duration,segments})});
      await Promise.all(session.clips.map(async(clip,index)=>{
        const upload=await fetch(init.segments[index].upload_url,{method:'PUT',headers:{'content-type':clip.blob.type||'audio/webm'},body:clip.blob});
        if(!upload.ok)throw new Error(`Audio insertion ${index+1} upload failed: ${upload.status}`);
      }));
      await api('/responses/complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({response_id:init.response_id,recording_id:session.recordingId})});
      session.stream?.getTracks().forEach(track=>track.stop());responseSession=null;
      responseNotice(session.recordingId,'Interleaved response submitted.');await loadRecordings();
    }catch(error){responseNotice(session.recordingId,error.message,true);session.composer.querySelector('.submit-response-button').disabled=false}
  }

  function waitFor(target,event){return new Promise(resolve=>target.addEventListener(event,resolve,{once:true}))}
  async function playInterleaved(responseId,button){
    if(interleavedPlayback){
      interleavedPlayback.source.pause();interleavedPlayback.clip?.pause();
      interleavedPlayback.button.textContent='▶ Play interleaved result';
      if(interleavedPlayback.responseId===responseId){interleavedPlayback=null;return}
    }
    const reply=responseIndex.get(responseId),thread=button.closest('.thread'),source=thread.querySelector('.source-audio');
    if(!reply||!source)return;
    const state={responseId,button,source,clip:null,cancelled:false};interleavedPlayback=state;
    button.textContent='■ Stop interleaved result';source.currentTime=0;
    const segments=(reply.segments||[]).slice().sort((a,b)=>a.anchor_seconds-b.anchor_seconds);
    for(const segment of segments){
      if(state.cancelled||interleavedPlayback!==state)return;
      if(source.currentTime>segment.anchor_seconds)source.currentTime=0;
      await source.play();
      while(source.currentTime<segment.anchor_seconds&&!source.ended&&interleavedPlayback===state)await Promise.race([waitFor(source,'timeupdate'),waitFor(source,'ended')]);
      source.pause();if(interleavedPlayback!==state)return;
      state.clip=new Audio();state.clip.crossOrigin='anonymous';state.clip.src=segment.play_url;await state.clip.play();await waitFor(state.clip,'ended');state.clip=null;
    }
    if(interleavedPlayback===state){await source.play();await waitFor(source,'ended')}
    if(interleavedPlayback===state){button.textContent='▶ Play interleaved result';interleavedPlayback=null}
  }

  $('recordings').onclick=e=>{
    const unlock=e.target.closest('[data-unlock-transcript]');
    if(unlock)return unlockTranscript(unlock.dataset.unlockTranscript,unlock);
    const interleaved=e.target.closest('[data-play-interleaved]');
    if(interleaved)return playInterleaved(interleaved.dataset.playInterleaved,interleaved);
    const respond=e.target.closest('[data-respond-to]');
    if(respond)return openResponseComposer(respond.dataset.respondTo);
    const composer=e.target.closest('.response-composer');
    if(!composer||!responseSession)return;
    if(e.target.closest('.submit-response-button'))submitResponse(responseSession);
  };

  function beginAnnotation(button,event){
    if(!responseSession||!button.closest('.response-composer'))return;
    event.preventDefault();
    responseSession.holdActive=true;
    if(event.pointerId!==undefined)button.setPointerCapture?.(event.pointerId);
    startResponseComment(responseSession);
  }
  function endAnnotation(event){
    if(!responseSession||!responseSession.holdActive)return;
    responseSession.holdActive=false;event?.preventDefault();
    stopResponseComment(responseSession);
  }
  $('recordings').addEventListener('pointerdown',event=>{
    const button=event.target.closest('.comment-button');if(button)beginAnnotation(button,event);
  });
  $('recordings').addEventListener('pointerup',endAnnotation);
  $('recordings').addEventListener('pointercancel',endAnnotation);
  $('recordings').addEventListener('keydown',event=>{
    const button=event.target.closest('.comment-button');
    if(button&&(event.key===' '||event.key==='Enter')&&!event.repeat)beginAnnotation(button,event);
  });
  $('recordings').addEventListener('keyup',event=>{
    if(event.key===' '||event.key==='Enter')endAnnotation(event);
  });

  function transcriptIsPresent(transcript){return Boolean(transcript&&transcript.status&&transcript.status!=='locked')}
  function applySearch(){
    const from=$('searchFrom').value?new Date($('searchFrom').value).getTime():null;
    const to=$('searchTo').value?new Date($('searchTo').value).getTime():null;
    const title=$('searchTitle').value.trim().toLowerCase();
    const author=$('searchAuthor').value.trim().toLowerCase();
    const min=$('searchMinResponses').value===''?null:Number($('searchMinResponses').value);
    const max=$('searchMaxResponses').value===''?null:Number($('searchMaxResponses').value);
    const transcript=$('searchTranscript').value;
    const speaker=$('searchSpeaker').value;
    const inquiry=$('searchInquiry').value;
    const sensitive=$('searchSensitive').value;
    const quarantine=$('searchQuarantine').value;
    const visible=recordingResults.filter(row=>{
      const time=new Date(row.item.created_at).getTime(),count=row.responses.length,present=transcriptIsPresent(row.transcript);
      const declared=row.responses.some(reply=>reply.speaks_for_our_lovely_system);
      const hasInquiry=Boolean(row.item.requests_additional_information)||row.responses.some(reply=>reply.requests_additional_information);
      const hasSensitive=Boolean(row.item.possible_sensitive_information)||row.responses.some(reply=>reply.possible_sensitive_information);
      const hasQuarantine=Boolean(row.item.contains_quarantine)||row.responses.some(reply=>reply.contains_quarantine);
      return (from===null||time>=from)&&(to===null||time<=to)&&
        (!title||String(row.item.title||'').toLowerCase().includes(title))&&
        (!author||String(row.item.self_id||'').toLowerCase().includes(author))&&
        (min===null||count>=min)&&(max===null||count<=max)&&
        (transcript==='any'||(transcript==='present'&&present)||(transcript==='null'&&!present))&&
        (speaker==='any'||(speaker==='declared'&&declared)||(speaker==='absent'&&!declared))&&
        (inquiry==='any'||(inquiry==='present'&&hasInquiry)||(inquiry==='absent'&&!hasInquiry))&&
        (sensitive==='any'||(sensitive==='present'&&hasSensitive)||(sensitive==='absent'&&!hasSensitive))&&
        (quarantine==='any'||(quarantine==='present'&&hasQuarantine)||(quarantine==='absent'&&!hasQuarantine));
    });
    $('recordings').innerHTML=visible.length?visible.map(row=>responseMarkup(row.item,row.responses,row.transcript)).join(''):'<p class="empty">No recordings match these controls.</p>';
    $('searchCount').textContent=`${visible.length} / ${recordingResults.length}`;
  }
  function updateMetrics(){
    const zero=recordingResults.filter(row=>row.responses.length===0).length;
    const insufficient=recordingResults.filter(row=>row.responses.filter(reply=>reply.speaks_for_our_lovely_system).length<3).length;
    $('zeroResponseMetric').textContent=zero;
    $('insufficientAckMetric').textContent=insufficient;
  }
  async function loadRecordings(){
    closeResponseSession();responseIndex.clear();$('recordings').innerHTML='<p class="empty">Loading recordings…</p>';
    try{
      const data=await api(`/recordings?message_type=${encodeURIComponent(mode)}&limit=50`);
      const [responses,transcripts]=await Promise.all([
        Promise.all(data.items.map(item=>getResponses(item.recording_id))),
        Promise.all(data.items.map(item=>getTranscript(item.recording_id)))
      ]);
      recordingResults=data.items.map((item,index)=>({item,responses:responses[index],transcript:transcripts[index]}));
      updateMetrics();applySearch();
    }catch(error){$('recordings').innerHTML=`<p class="empty">Recording browser unavailable: ${escapeHtml(error.message)}</p>`}
  }
  document.querySelectorAll('.search-strip input,.search-strip select').forEach(control=>{
    control.addEventListener(control.tagName==='SELECT'?'change':'input',applySearch);
  });
  $('clearSearch').onclick=()=>{
    document.querySelectorAll('.search-strip input').forEach(input=>input.value='');
    $('searchTranscript').value='any';$('searchSpeaker').value='any';$('searchInquiry').value='any';$('searchSensitive').value='any';$('searchQuarantine').value='any';applySearch();
  };
  function setSearchCollapsed(collapsed){
    document.body.classList.toggle('search-collapsed',collapsed);
    $('toggleSearch').textContent=collapsed?'Show filters':'Hide filters';
    $('toggleSearch').setAttribute('aria-expanded',String(!collapsed));
    try{localStorage.setItem('tinman-search-collapsed',collapsed?'1':'0')}catch(_){}
  }
  let searchCollapsed=false;
  try{searchCollapsed=localStorage.getItem('tinman-search-collapsed')==='1'}catch(_){}
  setSearchCollapsed(searchCollapsed);
  $('toggleSearch').onclick=()=>setSearchCollapsed(!document.body.classList.contains('search-collapsed'));

  $('refreshButton').onclick=loadRecordings;drawIdleMeter();addEventListener('resize',drawIdleMeter);loadRecordings();
})();
