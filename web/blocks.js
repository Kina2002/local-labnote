/* Independent memo, drawing and paper blocks share the record canvas. */
const customBlockKinds={section:'기록 항목',memo:'메모',drawing:'그림',reference:'논문 레퍼런스'};
const blockCategoryLabels={general:'일반',purpose:'목적',materials:'재료',conditions:'조건',procedure:'과정',observations:'관찰',results:'결과',reflection:'내 생각',references:'참고 자료'};

function safePaperUrl(value){
  try{let text=String(value||'').trim();if(/^10\.\d{4,9}\//i.test(text))text=`https://doi.org/${text}`;const url=new URL(text);return ['http:','https:'].includes(url.protocol)?url.href:''}catch{return ''}
}

function renderReferenceLinks(block,textarea){
  let box=block.querySelector('.reference-links');
  if(!box){box=document.createElement('div');box.className='reference-links';textarea.after(box)}
  box.replaceChildren();
  const found=new Map();
  for(const match of textarea.value.matchAll(/https?:\/\/[^\s<>"']+/gi)){
    const raw=match[0].replace(/[),.;\]}]+$/,'');const url=safePaperUrl(raw);
    if(url)found.set(url,raw);
  }
  for(const match of textarea.value.matchAll(/\b10\.\d{4,9}\/[^\s<>"']+/gi)){
    const doi=match[0].replace(/[),.;\]}]+$/,'');const url=safePaperUrl(`https://doi.org/${doi}`);
    if(url&&!found.has(url))found.set(url,`DOI: ${doi}`);
  }
  for(const [url,label] of found){const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.textContent=`${label} ↗`;box.append(link)}
  box.classList.toggle('hidden',!found.size);
}

function customBlockLabel(item){return item.title||customBlockKinds[item.kind]||'블록'}

function wireBlockPicker(){
  $('block-picker').querySelectorAll('[data-create-block]').forEach(button=>button.onclick=()=>createCustomBlock(button.dataset.createBlock));
  $('block-picker').querySelectorAll('[data-create-category]').forEach(button=>button.onclick=()=>createCustomBlock('section',{category:button.dataset.createCategory}));
}

async function createCustomBlock(kind,payload={}){
  if(!current||current.archived)return;
  const id=current.id,category=payload.category||'general';
  try{
    await persistRecordEdits();
    if(current?.id!==id)return;
    const before=new Set(current.blocks.map(block=>block.id));
    current=await api(`/api/experiments/${id}/blocks`,'POST',{kind,category,...payload});
    const added=current.blocks.find(block=>!before.has(block.id));
    renderSections();
    $('block-picker').classList.add('hidden');$('add-block').setAttribute('aria-expanded','false');
    if(added){turnToSection(added.id,true);$(`section-${added.id}`).querySelector(kind==='reference'?'.custom-title':'.custom-content')?.focus()}
    toast(`${kind==='section'?blockCategoryLabels[category]:customBlockKinds[kind]} 블록을 추가했습니다.`);
    return added;
  }catch(error){toast(error.message);return null}
}

function saveCustomBlock(blockId,patch){
  if(!current||current.archived)return Promise.resolve();
  const experimentId=current.id;
  saveQueue=saveQueue.catch(()=>{}).then(async()=>{
    try{
      const saved=await api(`/api/experiments/${experimentId}/blocks/${blockId}`,'POST',patch);
      if(current?.id!==experimentId)return;
      current=saved;syncRecordBlocks();
      $('updated-at').textContent=`마지막 저장 ${new Date(current.updated_at).toLocaleString('ko-KR')}`;
    }catch(error){toast(error.message)}
  });
  return saveQueue;
}

function wireCustomLayout(block,item){
  const key=item.id;
  block.querySelector('.remove-block').onclick=()=>changeBlockLayout({key,removed:1});
  const drag=block.querySelector('.block-drag');
  if(current.archived){block.querySelector('.remove-block').remove();block.querySelector('.block-resize').remove();drag.disabled=true;return}
  installBlockPointerControl(block,drag,'move');
  installBlockPointerControl(block,block.querySelector('.block-resize'),'resize');
  drag.onkeydown=event=>{
    const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-10],ArrowDown:[0,10]}[event.key];
    if(!delta)return;event.preventDefault();
    changeBlockLayout({key,pos_x:Math.max(0,Math.min(100-(item.width||100),(item.pos_x||0)+delta[0])),pos_y:Math.max(0,(item.pos_y||0)+delta[1])});
  };
}

function renderCustomBlocks(container){
  for(const item of current.blocks||[]){
    const label=customBlockLabel(item),key=item.id,block=document.createElement('section');
    block.className=`section custom-block custom-${item.kind}`;block.dataset.key=key;block.id=`section-${key}`;
    const heading=item.kind==='section'?`<h2>${escapeHtml(blockCategoryLabels[item.category]||label)}</h2>`:`<input class="custom-title" maxlength="160" aria-label="블록 제목" value="${escapeHtml(item.title)}">`;
    const placeholder=item.kind==='section'?placeholders[item.category]||'내용을 적어 주세요.':item.kind==='memo'?'메모를 적어 주세요.':item.kind==='drawing'?'그림 설명을 적어 주세요.':'논문의 핵심 내용과 이 실험의 관련성을 적어 주세요.';
    block.innerHTML=`<div class="section-head"><button class="block-drag" type="button" aria-label="${escapeHtml(label)} 블록 이동" title="끌어서 이동 · 방향키로 미세 조정">⠿</button><div class="custom-heading">${heading}</div><div class="section-controls"><button class="custom-draw" type="button" aria-label="그림 그리기" title="그림 그리기">✎</button><button class="add-file" type="button" aria-label="파일·사진 추가" title="파일·사진 추가">📎</button><button class="lock-button ${item.ai_allowed?'':'locked'}" type="button" aria-label="${item.ai_allowed?'로컬 AI 허용':'AI 사용 금지'}" title="${item.ai_allowed?'로컬 AI 허용':'AI 사용 금지'}">${item.ai_allowed?'🏠':'🔒'}</button><button class="remove-block" type="button" aria-label="${escapeHtml(label)} 블록 삭제" title="블록 삭제 · 블록 추가에서 복원 가능">×</button><input type="file" hidden accept=".png,.jpg,.jpeg,.webp,.csv,.xlsx,.pdf"></div></div><div class="custom-body"><label class="custom-url-row">논문 주소 또는 DOI 링크<input class="custom-url" type="url" maxlength="1000" placeholder="https://doi.org/..."></label><div class="custom-open-link"></div><textarea class="custom-content" aria-label="${escapeHtml(label)} 내용" placeholder="${escapeHtml(placeholder)}">${escapeHtml(item.content)}</textarea><div class="attachments"></div></div><button class="block-resize" type="button" aria-label="${escapeHtml(label)} 블록 크기 조절" title="끌어서 크기 조절 · 두 번 클릭하면 내용에 맞춤">◢</button>`;
    block.querySelector('.section-head').after(makeActualTimeRow(item,value=>saveCustomBlock(key,{event_at:value}),Boolean(current.archived)));
    const title=block.querySelector('.custom-title'),content=block.querySelector('.custom-content'),url=block.querySelector('.custom-url');
    attachNoteEditor(content);
    content.readOnly=url.readOnly=Boolean(current.archived);
    if(title){title.readOnly=Boolean(current.archived);title.onblur=()=>{if(title.value.trim()!==item.title)saveCustomBlock(key,{title:title.value})};title.oninput=()=>syncRecordBlocks()}
    content.onblur=()=>{if(content.value!==item.content)saveCustomBlock(key,{content:content.value})};
    content.oninput=()=>{resizeSectionTextarea(content);scheduleRecordLayout();if(item.kind==='section'&&item.category==='references')renderReferenceLinks(block,content)};
    url.onblur=()=>{if(url.value.trim()!==item.url)saveCustomBlock(key,{url:url.value})};
    url.oninput=()=>renderCustomPaperLink(block,url.value);
    block.querySelector('.custom-url-row').classList.toggle('hidden',item.kind!=='reference');
    renderCustomPaperLink(block,item.url);
    if(item.kind==='section'&&item.category==='references')renderReferenceLinks(block,content);
    const draw=block.querySelector('.custom-draw');draw.classList.toggle('hidden',item.kind!=='drawing');draw.disabled=Boolean(current.archived);
    draw.onclick=()=>openDrawingChooser(item.category==='general'?'observations':item.category,key);
    block.querySelector('.lock-button').disabled=Boolean(current.archived);
    block.querySelector('.lock-button').onclick=()=>saveCustomBlock(key,{ai_allowed:!Boolean(item.ai_allowed)}).then(()=>renderSections());
    const fileInput=block.querySelector('input[type=file]');block.querySelector('.add-file').disabled=Boolean(current.archived);
    block.querySelector('.add-file').onclick=()=>fileInput.click();
    fileInput.onchange=()=>{if(fileInput.files[0])uploadFile(item.category==='general'?'observations':item.category,fileInput.files[0],key);fileInput.value=''};
    for(const file of current.attachments.filter(file=>file.block_id===key))block.querySelector('.attachments').append(makeAttachment(file));
    appendRemovedImages(block,null,key);
    wireCustomLayout(block,item);
    container.append(block);
    resizeSectionTextarea(content);
  }
}

function renderCustomPaperLink(block,value){
  const host=block.querySelector('.custom-open-link'),safe=safePaperUrl(value);host.replaceChildren();
  if(safe){const link=document.createElement('a');link.href=safe;link.target='_blank';link.rel='noopener noreferrer';link.textContent='논문 원문 열기 ↗';host.append(link)}
  host.classList.toggle('hidden',!safe);
}

function syncCustomBlockNavigation(contents,removedPicker){
  let visible=0;
  for(const item of current.blocks||[]){
    const block=$(`section-${item.id}`);if(!block)continue;
    block.classList.toggle('hidden',Boolean(item.removed));
    if(item.removed){
      const button=document.createElement('button');button.type='button';button.textContent=`↩ ${customBlockLabel(item)} 복원`;
      button.onclick=()=>changeBlockLayout({key:item.id,shown:1,removed:0});removedPicker.append(button);
    }else{
      visible++;
      const button=document.createElement('button');button.type='button';button.dataset.key=item.id;
      button.textContent=block.querySelector('.custom-title')?.value||customBlockLabel(item);
      button.setAttribute('aria-controls',block.id);button.onclick=()=>turnToSection(item.id,true);contents.append(button);
    }
  }
  removedPicker.classList.toggle('hidden',!removedPicker.children.length);
  return visible;
}
