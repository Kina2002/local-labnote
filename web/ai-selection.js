/* Select specific permitted notes and files across experiments for local analysis. */
let aiCatalog=[],aiSelected=new Set(),aiExpanded=new Set(),aiSelectionVersion=0,aiCatalogRequest=0;
const aiSourceKey=(record,item)=>`${record.id}|${item.id}`;

async function refreshAiModelStatus(){
  const indicator=$('ai-connection');
  indicator.textContent='로컬 AI 연결을 확인하는 중…';
  indicator.classList.remove('ready');
  try{
    const status=await api('/api/ai-status');
    indicator.textContent=status.message;
    indicator.classList.toggle('ready',status.ready);
  }catch(error){indicator.textContent=`로컬 AI 상태를 확인하지 못했습니다: ${error.message}`}
}

function selectedAiPayload(){
  return aiCatalog.map(record=>({[record.scope==='book'?'notebook_id':'experiment_id']:record.id,items:record.items.filter(item=>item.allowed&&aiSelected.has(aiSourceKey(record,item))).map(item=>item.id)})).filter(record=>record.items.length);
}

function invalidateAiMaterialPreview(){
  aiSelectionVersion++;
  $('ai-material-preview').classList.add('hidden');
  $('ai-material-preview').textContent='';
}

function aiSelectionChanged(){
  invalidateAiMaterialPreview();
  $('ai-answer').textContent='';
  renderAiSourceList();
  renderAiSelectionSummary();
}

function renderAiSelectionSummary(){
  const selected=selectedAiPayload(),count=selected.reduce((sum,record)=>sum+record.items.length,0);
  const currentRecord=aiCatalog.find(record=>record.scope==='book'&&record.id===selectedBookId);
  const locked=currentRecord?.items.filter(item=>!item.allowed).length||0;
  const lines=selected.map(entry=>{
    const record=aiCatalog.find(item=>item.id===(entry.notebook_id||entry.experiment_id));
    return `${record.code} ${record.title}: ${record.items.filter(item=>entry.items.includes(item.id)).map(item=>item.label).join(', ')}`;
  });
  $('ai-preview').textContent=count?`선택한 책·실험 ${selected.length}개 · 항목 ${count}개\n${lines.join('\n')}${count>24?'\n한 번에 최대 24개 항목까지 분석할 수 있습니다.':''}`:locked?`선택한 자료가 없습니다. 현재 책 설계의 ${locked}개 항목이 AI 사용 금지 상태입니다. 필요한 항목 옆의 ‘허용하고 선택’을 눌러 주세요.`:'선택한 자료가 없습니다. 책·실험을 펼쳐 필요한 항목을 골라 주세요.';
  $('ai-preview-button').disabled=!count||count>24||selected.length>20;
  $('run-analysis').disabled=false;
}

function renderAiSourceList(){
  const host=$('ai-source-list'),scroll=host.scrollTop,query=$('ai-record-search').value.trim().toLocaleLowerCase('ko');
  host.replaceChildren();
  const records=aiCatalog.filter(record=>`${record.code} ${record.title} ${record.date} ${record.notebook_title}`.toLocaleLowerCase('ko').includes(query));
  if(!records.length){const empty=document.createElement('p');empty.className='ai-empty';empty.textContent='찾은 책·실험이 없습니다.';host.append(empty)}
  for(const record of records){
    const row=document.createElement('div');row.className='ai-record';
    const head=document.createElement('div');head.className='ai-record-head';
    const allowedItems=record.items.filter(item=>item.allowed);
    const label=document.createElement('label'),checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.disabled=!allowedItems.length;
    const checked=allowedItems.filter(item=>aiSelected.has(aiSourceKey(record,item))).length;
    checkbox.checked=Boolean(allowedItems.length)&&checked===allowedItems.length;
    checkbox.indeterminate=checked>0&&checked<allowedItems.length;
    checkbox.setAttribute('aria-label',`${record.code} ${record.title} 전체 항목 선택`);
    checkbox.onchange=()=>{for(const item of allowedItems){const key=aiSourceKey(record,item);if(checkbox.checked)aiSelected.add(key);else aiSelected.delete(key)}aiSelectionChanged()};
    const title=document.createElement('strong');title.textContent=`${record.code} ${record.title}`;
    label.append(checkbox,title);head.append(label);
    const date=document.createElement('small');date.textContent=record.scope==='book'?'연구 설계':`${$('ai-scope').value==='all'?record.notebook_title+' · ':''}${record.date||'날짜 미상'}`;head.append(date);
    const expand=document.createElement('button');expand.type='button';expand.textContent=record.items.length?`${checked}/${allowedItems.length} 선택 · ${aiExpanded.has(record.id)?'접기':'항목 보기'}`:'내용 없음';expand.disabled=!record.items.length;
    expand.onclick=()=>{if(aiExpanded.has(record.id))aiExpanded.delete(record.id);else aiExpanded.add(record.id);renderAiSourceList()};head.append(expand);row.append(head);
    if(aiExpanded.has(record.id)&&record.items.length){
      const grid=document.createElement('div');grid.className='ai-record-items';
      for(const item of record.items){
        const itemRow=document.createElement('div');itemRow.className='ai-item-row';
        const itemLabel=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.checked=item.allowed&&aiSelected.has(aiSourceKey(record,item));input.disabled=!item.allowed;input.setAttribute('aria-label',`${record.code} ${item.label}`);
        input.onchange=()=>{if(input.checked)aiSelected.add(aiSourceKey(record,item));else aiSelected.delete(aiSourceKey(record,item));aiSelectionChanged()};
        const name=document.createElement('span');name.textContent=item.label;name.title=item.excerpt||item.label;
        const type=document.createElement('small');type.textContent=!item.allowed?'AI 사용 금지':item.kind==='file'?'파일':item.excerpt.replace(/\s+/g,' ').slice(0,38);type.title=item.excerpt;
        itemLabel.append(input,name,type);itemRow.append(itemLabel);
        if(!item.allowed){const allow=document.createElement('button');allow.type='button';allow.className='ai-allow-button';allow.textContent='🏠 허용하고 선택';allow.title='이 항목의 로컬 AI 접근을 켭니다. 허용 상태는 기록에 저장됩니다.';allow.onclick=()=>allowAiItem(record,item,allow);itemRow.append(allow)}
        grid.append(itemRow);
      }
      row.append(grid);
    }
    host.append(row);
  }
  host.scrollTop=scroll;
}

async function loadAiSelection(reset=true){
  if(reset){$('ai-scope').value='book';$('ai-record-search').value='';aiSelected=new Set();aiExpanded=new Set(selectedBookId?[selectedBookId]:[])}
  const request=++aiCatalogRequest,scope=$('ai-scope').value;
  $('ai-source-list').textContent='실험 목록을 불러오는 중…';
  const query=scope==='book'&&selectedBookId?`?notebook_id=${encodeURIComponent(selectedBookId)}`:'';
  const result=await api(`/api/ai-sources${query}`);
  if(request!==aiCatalogRequest)return;
  aiCatalog=result.records;
  const keys=new Set(aiCatalog.flatMap(record=>record.items.filter(item=>item.allowed).map(item=>aiSourceKey(record,item))));
  aiSelected=new Set([...aiSelected].filter(key=>keys.has(key)));
  aiSelectionChanged();
}

function applyAiCategoryPreset(categories){
  const targets=new Set(selectedAiPayload().map(record=>record.experiment_id).filter(Boolean));
  if(!targets.size){toast('먼저 실험 항목을 하나 이상 선택해 주세요.');return}
  aiSelected=new Set(aiCatalog.filter(record=>targets.has(record.id)).flatMap(record=>record.items.filter(item=>item.allowed&&categories.includes(item.category)).map(item=>aiSourceKey(record,item))));
  aiSelectionChanged();
}

async function allowAiItem(record,item,button){
  button.disabled=true;button.textContent='허용 중…';
  try{
    const [type,id]=item.id.split(':');
    const path=type==='plan'?`/api/${record.scope==='book'?'notebooks':'experiments'}/${record.id}/planning/${id}`:type==='section'?`/api/experiments/${record.id}/sections/${id}`:type==='block'?`/api/experiments/${record.id}/blocks/${id}`:`/api/attachments/${id}/ai-access`;
    const saved=await api(path,'POST',{ai_allowed:true});
    if(type==='plan'&&record.scope==='book'&&planningState.book?.id===record.id){planningState.book={id:record.id,...saved};renderPlanning('book')}
    if(type==='plan'&&record.scope==='experiment'&&current?.id===record.id){current.planning=saved;planningState.experiment={id:record.id,...saved};renderPlanning('experiment')}
    if(type!=='plan'&&current?.id===record.id){current=saved;renderSections()}
    await loadAiSelection(false);
    aiSelected.add(aiSourceKey(record,item));aiSelectionChanged();
  }catch(error){toast(error.message);button.disabled=false;button.textContent='🏠 허용하고 선택'}
}

async function previewAiSelection(){
  const version=aiSelectionVersion,button=$('ai-preview-button');button.disabled=true;button.textContent='미리보기 준비 중…';
  try{
    const preview=await api('/api/ai-selection-preview','POST',{selections:selectedAiPayload(),question:$('ai-question').value.trim()});
    if(version!==aiSelectionVersion)return;
    $('ai-material-preview').textContent=preview.text+(preview.image_count?`\n\n[사진 ${preview.image_count}개도 함께 전달]`:'');
    $('ai-material-preview').classList.remove('hidden');
  }catch(error){$('ai-material-preview').textContent=error.message;$('ai-material-preview').classList.remove('hidden')}
  finally{button.textContent='전달 내용 미리보기';renderAiSelectionSummary()}
}

async function runAiSelection(){
  const selected=selectedAiPayload(),count=selected.reduce((sum,record)=>sum+record.items.length,0);
  if(!count){$('ai-answer').textContent='질문에 사용할 자료가 없습니다. 책·실험을 펼쳐 필요한 자료 옆의 ‘허용하고 선택’을 누르거나, 이미 허용된 항목을 체크해 주세요.';return}
  if(count>24||selected.length>20){$('ai-answer').textContent='한 번에 책·실험 20개, 항목 24개까지 사용할 수 있습니다. 선택을 줄여 주세요.';return}
  const button=$('run-analysis');button.disabled=true;button.textContent='로컬 AI가 분석 중…';$('ai-answer').textContent='';
  try{
    const result=await api('/api/ai-selection-analyze','POST',{selections:selectedAiPayload(),question:$('ai-question').value.trim()});
    $('ai-answer').textContent=`답변 초안 · 책·실험 ${result.used.records.length}개 / 항목 ${result.used.item_count}개\n\n${result.answer}`;
  }catch(error){$('ai-answer').textContent=error.message;refreshAiModelStatus()}
  finally{button.textContent='선택한 자료로 질문';renderAiSelectionSummary()}
}

function wireAiSelection(){
  $('ai-scope').onchange=()=>loadAiSelection(false).catch(error=>toast(error.message));
  $('ai-record-search').oninput=renderAiSourceList;
  $('ai-pick-conditions').onclick=()=>applyAiCategoryPreset(['conditions']);
  $('ai-pick-cause').onclick=()=>applyAiCategoryPreset(['conditions','observations','results']);
  $('ai-clear-selection').onclick=()=>{aiSelected.clear();aiSelectionChanged()};
  $('ai-preview-button').onclick=previewAiSelection;
  $('run-analysis').onclick=runAiSelection;
  $('ai-question').oninput=invalidateAiMaterialPreview;
}
