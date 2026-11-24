const token = document.getElementById('app').dataset.token;
const labels = {purpose:'목적',materials:'재료',conditions:'조건',procedure:'과정',observations:'관찰',results:'결과',reflection:'내 생각',references:'참고 자료'};
const placeholders = {purpose:'이 실험에서 알아보려는 것은 무엇인가요?',materials:'사용한 시약·시료·장비를 적어 주세요.\n이름, 제조사, lot, 사용량 등을 함께 남기면 좋아요.',conditions:'온도, 시간, 농도, 습도 등 실험 조건을 적어 주세요.\n바꾼 조건과 일정하게 유지한 조건을 구분해 보세요.',procedure:'실제로 진행한 순서대로 적어 주세요.\n1. \n2. \n3. ',observations:'실험 중 눈에 띈 변화나 예상 밖의 일을 적어 주세요.',results:'측정 결과와 실패한 결과도 함께 남겨 주세요.',reflection:'결과에 대한 생각과 다음에 확인할 점을 적어 주세요.',references:'자료명: \n출처 링크 또는 DOI: \n참고한 내용: '};
let activeSection = 'purpose', pagedExperimentId = null;
let experiments = [], current = null, view = 'timeline', calendarMonth = new Date(), selectedCalendarDay = null;
let saveQueue = Promise.resolve();
let recordNavigationPending = false;
const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const displayNumber = number => `EXP-${String(number).padStart(3,'0')}`;
const recordNumber = exp => exp.record_code || (exp.record_type==='literature' ? `LIT-${String(exp.number).padStart(3,'0')}` : displayNumber(exp.number));
const fmtDate = date => !date ? '수행일 미상' : new Date(`${date}T12:00:00`).toLocaleDateString('ko-KR',{year:'numeric',month:'long',day:'numeric'});
function toast(message){const el=$('toast');el.textContent=message;el.classList.add('visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('visible'),3300)}
async function api(path, method='GET', data){const response=await fetch(path,{method,headers:{'X-Labnote-Token':token,...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});const value=await response.json();if(!response.ok)throw new Error(value.error||'요청을 완료하지 못했습니다.');return value}
async function refreshList(){experiments=await api('/api/experiments');await refreshShelf();if(contentsQuery)await requestContentsSearch();else renderSidebar();if(current)renderExperimentNavigation();$('welcome-new').textContent=experiments.length?'새 실험 기록하기 ↗':'첫 실험 기록하기 ↗'}
function renderSidebar(){const box=$('sidebar-content');box.innerHTML='';$('timeline-tab').classList.toggle('active',view==='timeline');$('calendar-tab').classList.toggle('active',view==='calendar');const shown=visibleExperiments();renderContentsStatus(shown);if(!shown.length){const empty=document.createElement('div');empty.className='side-empty';empty.textContent=contentsEmptyMessage();box.append(empty);return}if(view==='timeline')renderTimeline(box,shown);else renderCalendar(box,shown)}
function makeExperimentLink(exp){const button=document.createElement('button');button.className='experiment-link'+(current?.id===exp.id?' selected':'');button.innerHTML=`<span class="list-number">${escapeHtml(recordNumber(exp))}</span><span style="min-width:0"><span class="list-title">${escapeHtml(exp.title)}</span><span class="list-date">${exp.record_type==='literature'?'문헌 재구성 · 회차 미상':`${exp.run_number||1}회차 · ${fmtDate(exp.experiment_date)}`}</span></span>`;button.onclick=()=>openExperiment(exp.id);return button}
function renderTimeline(box,shown){let previous=null;for(const exp of shown){const month=exp.experiment_date.slice(0,7);if(contentsSort.startsWith('date-')&&month!==previous){const heading=document.createElement('div');heading.className='timeline-month';heading.textContent=month?new Date(`${month}-01T12:00:00`).toLocaleDateString('ko-KR',{year:'numeric',month:'long'}):'수행일 미상';box.append(heading);previous=month}box.append(makeExperimentLink(exp))}}
function renderCalendar(box,shown){const year=calendarMonth.getFullYear(),month=calendarMonth.getMonth();const head=document.createElement('div');head.className='calendar-header';head.innerHTML=`<button aria-label="이전 달">‹</button><span>${year}년 ${month+1}월</span><button aria-label="다음 달">›</button>`;head.children[0].onclick=()=>{calendarMonth=new Date(year,month-1,1);selectedCalendarDay=null;renderSidebar()};head.children[2].onclick=()=>{calendarMonth=new Date(year,month+1,1);selectedCalendarDay=null;renderSidebar()};box.append(head);const grid=document.createElement('div');grid.className='calendar-grid';for(const day of ['일','월','화','수','목','금','토']){const label=document.createElement('span');label.className='calendar-weekday';label.textContent=day;grid.append(label)}const start=new Date(year,month,1).getDay(),days=new Date(year,month+1,0).getDate();for(let i=0;i<start;i++)grid.append(document.createElement('span'));for(let day=1;day<=days;day++){const date=`${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;const button=document.createElement('button');button.className='calendar-day'+(shown.some(exp=>exp.experiment_date===date)?' has-record':'')+(selectedCalendarDay===date?' selected-day':'');button.textContent=day;button.onclick=()=>{selectedCalendarDay=date;renderSidebar()};grid.append(button)}box.append(grid);const date=selectedCalendarDay||new Date().toISOString().slice(0,10);const list=document.createElement('div');list.className='calendar-records';const title=document.createElement('small');title.textContent=fmtDate(date);list.append(title);const matching=shown.filter(exp=>exp.experiment_date===date);if(matching.length)matching.forEach(exp=>list.append(makeExperimentLink(exp)));else{const empty=document.createElement('small');empty.textContent='이날의 실험 기록이 없습니다.';list.append(empty)}box.append(list)}
async function openExperiment(id){try{current=await api(`/api/experiments/${id}`);selectedBookId=current.notebook_id;renderBookNav();$('shelf').classList.add('hidden');$('book-home').classList.add('hidden');$('welcome').classList.add('hidden');$('notebook').classList.remove('hidden');$('experiment-number').textContent=recordNumber(current);$('crumb-number').textContent=recordNumber(current);$('crumb-book').textContent=currentBook()?.title||'책';$('experiment-title').value=current.title;$('experiment-date').value=current.experiment_date;$('record-code').value=current.record_code||'';fillTopicSelect($('record-topic'),current.topic_id||'');$('top-status').textContent=`${recordNumber(current)} · ${fmtDate(current.experiment_date)}`;$('updated-at').textContent=`마지막 저장 ${new Date(current.updated_at).toLocaleString('ko-KR')}`;renderSections();updateRecordHeader();renderSidebar();window.scrollTo(0,0)}catch(error){toast(error.message)}}
function renderSections(){
  if(pagedExperimentId!==current.id){activeSection='purpose';pagedExperimentId=current.id}
  const box=$('sections');box.innerHTML='';
  for(const [key,label] of Object.entries(labels)){
    const section=current.sections[key],files=current.attachments.filter(file=>file.section_key===key);
    const block=document.createElement('section');block.className='section';block.dataset.key=key;block.id=`section-${key}`;
    block.innerHTML=`<div class="section-head"><h2>${label}</h2><div class="section-controls"><button class="add-file">＋ 파일·사진</button><button class="lock-button ${section.ai_allowed?'':'locked'}">${section.ai_allowed?'🏠 로컬 AI 허용':'🔒 AI 사용 금지'}</button><input type="file" hidden accept=".png,.jpg,.jpeg,.webp,.csv,.xlsx,.pdf"></div></div><textarea aria-label="${label} 기록" placeholder="${placeholders[key]}">${escapeHtml(section.content)}</textarea><div class="attachments"></div>`;
    const textarea=block.querySelector('textarea');textarea.readOnly=Boolean(current.archived);
    const drawingButton=document.createElement('button');drawingButton.type='button';drawingButton.className='add-drawing';drawingButton.textContent='＋ 그림 추가';drawingButton.disabled=Boolean(current.archived);drawingButton.onclick=()=>openDrawingChooser(key);block.querySelector('.section-controls').prepend(drawingButton);
    attachNoteEditor(textarea);
    textarea.onblur=()=>{if(!current.archived&&textarea.value!==current.sections[key].content)saveSection(key,textarea.value,Boolean(current.sections[key].ai_allowed))};
    block.querySelector('.lock-button').onclick=()=>saveSection(key,textarea.value,!Boolean(current.sections[key].ai_allowed));
    const input=block.querySelector('input[type=file]');block.querySelector('.add-file').onclick=()=>input.click();
    input.onchange=()=>{if(input.files[0])uploadFile(key,input.files[0]);input.value=''};
    const attachments=block.querySelector('.attachments'),above=document.createElement('div');above.className='attachments attachments-before';block.insertBefore(above,block.querySelector('.note-editor-toolbar')||textarea);
    files.forEach(file=>(file.display_placement==='before'?above:attachments).append(makeAttachment(file)));
    appendRemovedImages(block,key);
    if(current.archived)block.querySelectorAll('.add-file,.lock-button').forEach(button=>button.disabled=true);
    box.append(block);
  }
  const contents=$('page-contents');contents.innerHTML='';
  Object.entries(labels).forEach(([key,label],index)=>{
    const button=document.createElement('button');button.type='button';button.dataset.key=key;button.setAttribute('aria-controls',`section-${key}`);
    button.innerHTML=`<span class="contents-index">${String(index+1).padStart(2,'0')}</span><span>${label}</span><span class="contents-leader"></span><span class="contents-arrow">↗</span>`;
    button.onclick=()=>turnToSection(key);contents.append(button);
  });
  $('previous-page').onclick=()=>navigateExperiment(-1);
  $('next-page').onclick=()=>navigateExperiment(1);
  turnToSection(activeSection);
}
function turnToSection(key){
  if(!labels[key])return;
  activeSection=key;
  document.querySelectorAll('#sections > .section').forEach(section=>section.classList.toggle('hidden',section.dataset.key!==key));
  document.querySelectorAll('#page-contents button').forEach(button=>{
    const selected=button.dataset.key===key;button.classList.toggle('active',selected);
    if(selected)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
  });
  const position=Object.keys(labels).indexOf(key)+1;
  $('page-position').textContent=`${String(position).padStart(2,'0')} / 08`;
  $('page-running-title').textContent=`${recordNumber(current)} · ${labels[key]}`;
  renderExperimentNavigation();
}
function experimentsInCurrentBook(){
  return current&&!current.archived?filterContentsRecords(current.notebook_id):[];
}
function renderExperimentNavigation(){
  const records=experimentsInCurrentBook(),index=records.findIndex(exp=>exp.id===current?.id);
  const previous=index>0?records[index-1]:null,next=index>=0?records[index+1]:null;
  $('page-folio').textContent=current?.archived?'보관된 기록':contentsSearching?'검색 중…':index>=0?`${contentsQuery?'검색 결과':'실험'} ${index+1} / ${records.length}`:contentsQuery?'검색 결과 밖의 기록':'';
  $('previous-page').disabled=recordNavigationPending||contentsSearching||!previous;
  $('next-page').disabled=recordNavigationPending||contentsSearching||!next;
  $('previous-page').title=previous?`${recordNumber(previous)} · ${previous.title}`:'현재 목록에 이전 실험이 없습니다.';
  $('next-page').title=next?`${recordNumber(next)} · ${next.title}`:'현재 목록에 다음 실험이 없습니다.';
}
async function navigateExperiment(direction){
  if(recordNavigationPending||contentsSearching||!current||current.archived)return;
  const records=experimentsInCurrentBook(),index=records.findIndex(exp=>exp.id===current.id);
  const target=index>=0?records[index+direction]:null;
  if(!target)return;
  const sourceId=current.id,section=activeSection;
  recordNavigationPending=true;renderExperimentNavigation();
  try{
    await persistRecordEdits();
    if(current?.id!==sourceId)return;
    await openExperiment(target.id);
    if(current?.id===target.id)turnToSection(section);
  }catch(error){toast(`이동하지 못했습니다. ${error.message}`)}
  finally{recordNavigationPending=false;renderExperimentNavigation()}
}
function saveSection(key,content,ai_allowed){const experimentId=current.id;saveQueue=saveQueue.catch(()=>{}).then(async()=>{try{const saved=await api(`/api/experiments/${experimentId}/sections/${key}`,'POST',{content,ai_allowed});if(current?.id!==experimentId)return;current=saved;if(contentsQuery)requestContentsSearch();const block=[...document.querySelectorAll('.section')][Object.keys(labels).indexOf(key)];if(block){const button=block.querySelector('.lock-button');button.classList.toggle('locked',!ai_allowed);button.textContent=ai_allowed?'🏠 로컬 AI 허용':'🔒 AI 사용 금지'}$('updated-at').textContent=`마지막 저장 ${new Date(current.updated_at).toLocaleString('ko-KR')}`;toast('저장했습니다.')}catch(error){toast(error.message)}});return saveQueue}
function makeAttachment(file){
  const item=document.createElement('div');item.className='attachment';
  if(file.mime_type.startsWith('image/')){
    item.classList.add('attachment-image');
    if(file.regions?.length){
      const pair=document.createElement('div');pair.className='panel-comparison';
      for(const region of file.regions){
        const button=document.createElement('button');button.className='panel-preview';
        button.setAttribute('aria-label',`${region.label} 크게 보기`);
        button.onclick=()=>openAttachment({...file,view_regions:[region],display_title:`Figure ${region.figure} · ${region.label}`});
        const label=document.createElement('strong');label.textContent=region.label;
        const crop=document.createElement('span');crop.className='panel-window';crop.style.aspectRatio=`${region.width} / ${region.height}`;
        const image=document.createElement('img');image.alt=`논문 Figure ${region.figure} · ${region.label}`;
        Object.assign(image.style,{width:`${region.source_width/region.width*100}%`,left:`${-region.x/region.width*100}%`,top:`${-region.y/region.height*100}%`});
        loadImage(file.id,image);crop.append(image);button.append(label,crop);pair.append(button);
      }
      item.append(pair);
      const compare=document.createElement('button');compare.className='subtle-button compare-enlarge';compare.textContent='처리 전·후 함께 확대';
      compare.onclick=()=>openAttachment({...file,view_regions:file.regions,display_title:`Figure ${file.regions[0].figure} · 처리 전·후 (${file.regions.map(r=>r.panel).join(', ')})`});
      item.append(compare);
      const note=document.createElement('small');note.className='panel-source-note';note.textContent=`논문 Figure ${file.regions[0].figure} · 해당 조성만 표시 · 눈금 막대 100 μm`;
      item.append(note);
    }else{
      const preview=document.createElement('button');preview.className='image-preview';preview.setAttribute('aria-label',file.original_name+' 크게 보기');preview.onclick=()=>openAttachment(file);
      const image=document.createElement('img');image.alt=file.original_name;loadImage(file.id,image);preview.append(image);item.append(preview);
    }
  }
  const name=document.createElement('button');name.className='attachment-name';name.title=file.original_name;name.textContent=file.regions?.length?'논문 원본 전체 보기 ↗':file.original_name;name.onclick=()=>openAttachment(file);item.append(name);
  const lock=document.createElement('button');lock.className=`lock-button ${file.ai_allowed?'':'locked'}`;lock.textContent=file.ai_allowed?'🏠 AI 허용':'🔒 AI 금지';lock.title='원본 파일 전체의 로컬 AI 접근 설정';
  lock.disabled=Boolean(current?.archived);lock.onclick=async()=>{try{await saveQueue;current=await api(`/api/attachments/${file.id}/ai-access`,'POST',{ai_allowed:!file.ai_allowed});renderSections();toast('파일의 AI 접근 설정을 바꿨습니다.')}catch(error){toast(error.message)}};item.append(lock);
  if(file.mime_type.startsWith('image/'))attachImageLayout(item,file);return item;
}
async function loadImage(id,img){try{const response=await fetch(`/api/attachments/${id}`,{headers:{'X-Labnote-Token':token}});if(response.ok)img.src=URL.createObjectURL(await response.blob())}catch{}}
async function openAttachment(file){
  if(file.original_name.toLowerCase().match(/\.(csv|xlsx)$/)){showTable(file);return}
  try{
    const response=await fetch(`/api/attachments/${file.id}`,{headers:{'X-Labnote-Token':token}});
    if(!response.ok)throw new Error('파일을 열 수 없습니다.');
    const url=URL.createObjectURL(await response.blob());
    if(file.mime_type.startsWith('image/')){
      showImageViewer(file,url);
    }else{
      window.open(url,'_blank','noopener');setTimeout(()=>URL.revokeObjectURL(url),60000);
    }
  }catch(error){toast(error.message)}
}
function showImageViewer(file,url){
  const dialog=$('image-dialog'),image=$('enlarged-image'),viewport=$('image-viewport'),stage=$('image-stage'),content=$('image-content');
  if(dialog.open){URL.revokeObjectURL(url);return}
  const edit=$('image-annotate');edit.hidden=Boolean(current?.archived);edit.textContent=file.editable_drawing?'그림 다시 편집':'화살표·설명 넣기';edit.onclick=()=>{dialog.close();openDrawing(file.editable_drawing?'edit':'photo',file.section_key,file)};
  let zoom=1,ready=false,fitted=true,drag=null,logicalWidth=0,logicalHeight=0,sheet=null;
  const regions=file.view_regions||[];
  const fitScale=()=>Math.min(1,viewport.clientWidth/logicalWidth,viewport.clientHeight/logicalHeight);
  const minimum=()=>Math.min(.1,fitScale());
  const renderZoom=(next,x=viewport.clientWidth/2,y=viewport.clientHeight/2)=>{
    if(!ready)return;
    const pointX=(viewport.scrollLeft+x-content.offsetLeft)/zoom;
    const pointY=(viewport.scrollTop+y-content.offsetTop)/zoom;
    zoom=Math.max(minimum(),Math.min(4,next));
    const width=logicalWidth*zoom,height=logicalHeight*zoom;
    const left=Math.max(0,(viewport.clientWidth-width)/2),top=Math.max(0,(viewport.clientHeight-height)/2);
    stage.style.width=`${Math.max(viewport.clientWidth,width)}px`;
    stage.style.height=`${Math.max(viewport.clientHeight,height)}px`;
    Object.assign(content.style,{width:`${width}px`,height:`${height}px`,left:`${left}px`,top:`${top}px`});
    if(sheet)sheet.style.transform=`scale(${zoom})`;
    else Object.assign(image.style,{width:`${width}px`,height:`${height}px`,left:'0',top:'0'});
    viewport.scrollLeft=pointX*zoom+left-x;viewport.scrollTop=pointY*zoom+top-y;
    $('image-zoom-level').textContent=`${Math.round(zoom*100)}%`;
    $('image-zoom-out').disabled=zoom<=minimum()+.0001;
    $('image-zoom-in').disabled=zoom>=4;
    viewport.classList.toggle('can-pan',width>viewport.clientWidth||height>viewport.clientHeight);
  };
  const fit=()=>{fitted=true;renderZoom(fitScale());viewport.scrollTo(0,0)};
  $('image-dialog-title').textContent=file.display_title||file.original_name;image.alt=file.display_title||file.original_name;
  $('image-zoom-level').textContent='로딩 중';
  const controls=[...dialog.querySelectorAll('.image-zoom-controls button')];controls.forEach(button=>button.disabled=true);
  $('image-zoom-in').onclick=()=>{fitted=false;renderZoom(zoom*1.25)};
  $('image-zoom-out').onclick=()=>{fitted=false;renderZoom(zoom/1.25)};
  $('image-actual-size').onclick=()=>{fitted=false;renderZoom(1)};
  $('image-fit').onclick=fit;
  const wheel=event=>{
    event.preventDefault();if(!ready)return;
    const rect=viewport.getBoundingClientRect();fitted=false;
    const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?viewport.clientHeight:1);
    renderZoom(zoom*Math.exp(-Math.max(-200,Math.min(200,delta))*.002),event.clientX-rect.left,event.clientY-rect.top);
  };
  viewport.addEventListener('wheel',wheel,{passive:false});
  viewport.onpointerdown=event=>{
    if(event.pointerType==='touch'||event.button!==0||!viewport.classList.contains('can-pan'))return;
    event.preventDefault();viewport.focus({preventScroll:true});
    drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};
    viewport.setPointerCapture(event.pointerId);viewport.classList.add('dragging');
  };
  viewport.onpointermove=event=>{if(drag&&event.pointerId===drag.id){viewport.scrollLeft=drag.left+drag.x-event.clientX;viewport.scrollTop=drag.top+drag.y-event.clientY}};
  const endDrag=()=>{if(drag&&viewport.hasPointerCapture(drag.id))viewport.releasePointerCapture(drag.id);drag=null;viewport.classList.remove('dragging')};
  viewport.onpointerup=endDrag;viewport.onpointercancel=endDrag;viewport.onlostpointercapture=()=>{drag=null;viewport.classList.remove('dragging')};
  const resize=new ResizeObserver(()=>{if(ready&&dialog.open){if(fitted)fit();else renderZoom(zoom)}});
  image.onload=()=>{
    if(!dialog.open)return;
    logicalWidth=image.naturalWidth;logicalHeight=image.naturalHeight;
    if(regions.length){
      logicalWidth=regions.reduce((sum,r)=>sum+r.width,0)+24*(regions.length-1);
      logicalHeight=Math.max(...regions.map(r=>r.height))+40;
      sheet=document.createElement('div');sheet.className='region-sheet';Object.assign(sheet.style,{width:`${logicalWidth}px`,height:`${logicalHeight}px`});
      let left=0;
      for(const region of regions){
        const label=document.createElement('strong');label.textContent=region.label;Object.assign(label.style,{left:`${left}px`,width:`${region.width}px`});sheet.append(label);
        const pane=document.createElement('div');pane.className='region-pane';Object.assign(pane.style,{left:`${left}px`,top:'40px',width:`${region.width}px`,height:`${region.height}px`});
        const picture=document.createElement('img');picture.src=url;picture.alt=region.label;picture.draggable=false;
        Object.assign(picture.style,{width:`${image.naturalWidth}px`,height:`${image.naturalHeight}px`,left:`${-region.x}px`,top:`${-region.y}px`});
        pane.append(picture);sheet.append(pane);left+=region.width+24;
      }
      image.classList.add('hidden');content.append(sheet);
    }
    ready=true;controls.forEach(button=>button.disabled=false);fit();resize.observe(viewport);
  };
  image.onerror=()=>{if(dialog.open)dialog.close();toast('사진을 불러오지 못했습니다.')};
  dialog.onclose=()=>{
    ready=false;resize.disconnect();endDrag();viewport.removeEventListener('wheel',wheel);
    image.onload=null;image.onerror=null;image.removeAttribute('src');image.removeAttribute('style');
    sheet?.remove();image.classList.remove('hidden');content.removeAttribute('style');stage.removeAttribute('style');viewport.classList.remove('can-pan');URL.revokeObjectURL(url);
  };
  dialog.showModal();image.src=url;
}
async function showTable(file){try{const data=await api(`/api/attachments/${file.id}/data`);let box=document.getElementById(`chart-${file.id}`);if(box){box.remove();return}box=document.createElement('div');box.className='chart-box';box.id=`chart-${file.id}`;const section=[...document.querySelectorAll('.section')][Object.keys(labels).indexOf(file.section_key)]||$('sections');section.append(box);if(!data.numeric.length){box.textContent='숫자 열이 없어 그래프를 그릴 수 없습니다.';return}box.innerHTML='<div class="chart-controls"><span>그래프</span><select class="x-axis"></select><span>→</span><select class="y-axis"></select></div><svg viewBox="0 0 600 200" role="img" aria-label="실험 데이터 그래프"></svg><div class="chart-note"></div>';const x=box.querySelector('.x-axis'),y=box.querySelector('.y-axis');for(const col of data.columns){const option=document.createElement('option');option.value=col;option.textContent=`X: ${col}`;x.append(option)}for(const col of data.numeric){const option=document.createElement('option');option.value=col;option.textContent=`Y: ${col}`;y.append(option)}if(data.columns.length>1&&data.numeric[0]===data.columns[0]&&data.numeric.length>1)y.value=data.numeric[1];const draw=()=>drawChart(box,data,x.value,y.value);x.onchange=draw;y.onchange=draw;draw()}catch(error){toast(error.message)}}
function drawChart(box,data,xName,yName){const svg=box.querySelector('svg'),points=data.rows.filter(row=>Number.isFinite(Number(row[yName]))).slice(0,100);svg.innerHTML='';if(!points.length){box.querySelector('.chart-note').textContent='표에 숫자 결과가 없습니다.';return}const values=points.map(row=>Number(row[yName])),min=Math.min(...values),max=Math.max(...values),spread=max-min||1;const coords=values.map((value,index)=>`${48+(index/Math.max(points.length-1,1))*525},${165-((value-min)/spread)*125}`).join(' ');svg.innerHTML=`<line x1="48" y1="20" x2="48" y2="165" stroke="#b9cbb8"/><line x1="48" y1="165" x2="575" y2="165" stroke="#b9cbb8"/><polyline points="${coords}" fill="none" stroke="#3c7652" stroke-width="2.5" stroke-linejoin="round"/><text x="5" y="43" fill="#78917e" font-size="11">${Number(max.toPrecision(4))}</text><text x="5" y="165" fill="#78917e" font-size="11">${Number(min.toPrecision(4))}</text><text x="48" y="188" fill="#78917e" font-size="11">${escapeHtml(String(points[0][xName]??'').slice(0,20))}</text><text x="510" y="188" fill="#78917e" font-size="11">${escapeHtml(String(points.at(-1)[xName]??'').slice(0,20))}</text>`;box.querySelector('.chart-note').textContent=`${yName} · 전체 ${data.total_rows}행 중 ${points.length}개 표시${data.total_rows>data.shown_rows?' (첫 500행만 미리보기)':''}. 값의 의미와 단위는 원본 파일을 확인하세요.`}
function fileAsBase64(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('파일을 읽을 수 없습니다.'));reader.readAsDataURL(file)})}
async function uploadFile(sectionKey,file){if(file.size>15*1024*1024)return toast('15MB 이하 파일만 첨부할 수 있습니다.');try{toast('파일을 저장하는 중입니다…');await saveQueue;const data=await fileAsBase64(file);current=await api(`/api/experiments/${current.id}/attachments`,'POST',{section_key:sectionKey,name:file.name,data});renderSections();toast('첨부했습니다. 기본값은 🔒 AI 사용 금지입니다.')}catch(error){toast(error.message)}}
function saveMetadata(){
  if(!current||current.archived)return;
  const id=current.id,title=$('experiment-title').value.trim()||'새 실험',date=$('experiment-date').value,recordCode=$('record-code').value.trim(),topicId=$('record-topic').value||null;
  if(title===current.title&&date===current.experiment_date&&recordCode===(current.record_code||'')&&topicId===(current.topic_id||null))return;
  saveQueue=saveQueue.catch(()=>{}).then(async()=>{
    try{
      const saved=await api(`/api/experiments/${id}`,'POST',{title,experiment_date:date,record_code:recordCode,topic_id:topicId});
      if(current?.id!==id)return;
      current=saved;await refreshList();
      if(current?.id===id){$('experiment-number').textContent=recordNumber(current);$('crumb-number').textContent=recordNumber(current);$('top-status').textContent=`${recordNumber(current)} · ${fmtDate(current.experiment_date)}`;}
      toast('실험 정보를 저장했습니다.');
    }catch(error){toast(error.message)}
  });
  return saveQueue;
}
function openCreate(topicId=''){if(!selectedBookId)selectedBookId='personal';const dialog=$('create-dialog');$('new-title').value='';$('new-code').value='';fillTopicSelect($('new-topic'),typeof topicId==='string'?topicId:'');$('new-date').value=new Date().toLocaleDateString('en-CA');dialog.showModal();setTimeout(()=>$('new-title').focus(),30)}
async function showTools(){if(!current)return;try{await saveQueue;const preview=await api(`/api/experiments/${current.id}/ai-preview`);$('ai-preview').textContent=`AI가 읽을 항목: ${preview.sections.length?preview.sections.join(', '):'없음'}\nAI가 읽을 파일: ${preview.attachments.length?preview.attachments.join(', '):'없음'}\n제외된 항목·파일: ${preview.locked_count}개`;$('ai-answer').textContent='';$('tools-dialog').showModal()}catch(error){toast(error.message)}}
async function runAnalysis(){if(!current)return;const button=$('run-analysis');button.disabled=true;button.textContent='로컬 AI가 분석 중…';$('ai-answer').textContent='';try{const result=await api(`/api/experiments/${current.id}/analyze`,'POST',{question:$('ai-question').value.trim()||'허용한 내용에서 관찰되는 변화와 추가 확인할 점을 설명해 주세요.'});$('ai-answer').textContent=`분석 초안 · 사용한 항목: ${result.used.sections.join(', ')||'없음'} / 파일: ${result.used.attachments.join(', ')||'없음'}\n\n${result.answer}`}catch(error){$('ai-answer').textContent=error.message}finally{button.disabled=false;button.textContent='허용한 항목으로 분석'}}
async function runSearch(){const query=$('paper-query').value.trim();if(query.length<3)return toast('검색어를 3글자 이상 입력해 주세요.');if(!confirm(`인터넷의 Crossref에 아래 검색어만 보냅니다.\n\n${query}\n\n실험 기록과 첨부파일은 보내지 않습니다. 계속할까요?`))return;const button=$('run-search');button.disabled=true;button.textContent='논문을 찾는 중…';$('paper-results').textContent='';try{const result=await api('/api/papers/search','POST',{query});if(!result.papers.length){$('paper-results').textContent='검색 결과가 없습니다.';return}for(const paper of result.papers){const row=document.createElement('div');row.className='paper-result';const link=document.createElement('a');link.href=paper.url;link.target='_blank';link.rel='noopener noreferrer';link.textContent=paper.title;row.append(link);const meta=document.createElement('small');meta.textContent=`${paper.year||'연도 미상'} · DOI ${paper.doi||'없음'} · 원문 접근 여부는 별도 확인`;row.append(meta);$('paper-results').append(row)}}catch(error){$('paper-results').textContent=error.message}finally{button.disabled=false;button.textContent='검색어 확인하고 찾기'}}
$('new-experiment').onclick=()=>openCreate();$('welcome-new').onclick=()=>openCreate();$('create-dialog').addEventListener('close',async()=>{if($('create-dialog').returnValue!=='create')return;try{const exp=await api('/api/experiments','POST',{title:$('new-title').value,experiment_date:$('new-date').value,notebook_id:selectedBookId,topic_id:$('new-topic').value||null,record_code:$('new-code').value});await refreshList();await openExperiment(exp.id);toast('새 실험을 시작했습니다.')}catch(error){toast(error.message)}});$('timeline-tab').onclick=()=>{view='timeline';renderSidebar()};$('calendar-tab').onclick=()=>{view='calendar';calendarMonth=new Date();selectedCalendarDay=null;renderSidebar()};$('experiment-title').onblur=saveMetadata;$('experiment-date').onchange=saveMetadata;$('record-code').onblur=saveMetadata;$('record-topic').onchange=saveMetadata;$('open-tools').onclick=showTools;$('close-tools').onclick=()=>$('tools-dialog').close();$('analysis-tab').onclick=()=>{$('analysis-tab').classList.add('active');$('papers-tab').classList.remove('active');$('analysis-panel').classList.remove('hidden');$('papers-panel').classList.add('hidden')};$('papers-tab').onclick=()=>{$('papers-tab').classList.add('active');$('analysis-tab').classList.remove('active');$('papers-panel').classList.remove('hidden');$('analysis-panel').classList.add('hidden')};$('run-analysis').onclick=runAnalysis;$('run-search').onclick=runSearch;$('show-history').onclick=()=>{if(!current)return;$('history-list').innerHTML='';for(const revision of current.revisions){const row=document.createElement('div');row.className='history-row';const target=labels[revision.target]||(revision.target==='experiment'?'실험 정보':'첨부파일');row.textContent=`${target} · ${revision.action}`;const when=document.createElement('small');when.textContent=new Date(revision.created_at).toLocaleString('ko-KR');row.append(when);$('history-list').append(row)}$('history-dialog').showModal()};$('close-history').onclick=()=>$('history-dialog').close();refreshList().catch(error=>toast(error.message));
