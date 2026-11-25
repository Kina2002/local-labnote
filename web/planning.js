/* Book-wide and per-experiment design notes use independent, movable blocks. */
const planningState = {book:null,experiment:null};
const planningQueue = {book:Promise.resolve(),experiment:Promise.resolve()};
const planningBookView = {ownerId:null,openBlocks:new Set(),editBlocks:new Set(),openCards:new Map()};

function planningPanel(scope){return $(scope==='book'?'book-planning':'experiment-planning')}
function planningPath(scope,id){return `/api/${scope==='book'?'notebooks':'experiments'}/${id}/planning`}
function planningOwner(scope){return scope==='book'?selectedBookId:current?.id}
function planningLocked(scope){return scope==='book'?Boolean(currentBook()?.archived):Boolean(current?.archived)}
async function saveBookFormBeforeAction(scope){if(scope==='book')await flushPlanning('book')}
function planningEventValue(date,time){return date ? `${date}${time?`T${time}`:''}` : ''}
function planningDate(value){return String(value||'').slice(0,10)}
function planningTime(value){return String(value||'').includes('T')?String(value).slice(11,16):''}
function bookPlanningStatus(item){
  const filled=(item.form?.groups||[]).flatMap(group=>group.fields).filter(field=>field.value.trim()).length;
  const parts=[filled?`작성 ${filled}칸`:item.content.trim()?'메모 있음':'미작성'];
  if(filled&&item.content.trim())parts.push('메모 있음');
  if(item.form?.mode==='repeat'&&item.form.groups.length>1)parts.push(`카드 ${item.form.groups.length}개`);
  return parts.join(' · ');
}
function updateBookPlanningStatus(block){
  const status=block.querySelector('.planning-book-status');if(!status)return;
  const filled=[...block.querySelectorAll('.planning-field-value')].filter(field=>field.value.trim()).length;
  const memo=Boolean(block.querySelector('.planning-content')?.value.trim());
  const parts=[filled?`작성 ${filled}칸`:memo?'메모 있음':'미작성'];
  if(filled&&memo)parts.push('메모 있음');
  const cards=block.querySelectorAll('.planning-form-repeat .planning-form-group').length;
  if(cards>1)parts.push(`카드 ${cards}개`);
  status.textContent=parts.join(' · ');
}

function makeActualTimeRow(item,onchange,locked=false){
  const row=document.createElement('div');row.className='actual-time-row';
  const dateLabel=document.createElement('label');dateLabel.textContent='실제 날짜';
  const date=document.createElement('input');date.type='date';date.value=planningDate(item.event_at);date.disabled=locked;dateLabel.append(date);
  const timeLabel=document.createElement('label');timeLabel.textContent='시간 (선택)';
  const time=document.createElement('input');time.type='time';time.value=planningTime(item.event_at);time.disabled=locked;timeLabel.append(time);
  const save=()=>onchange(planningEventValue(date.value,time.value));date.onchange=save;time.onchange=save;
  row.append(dateLabel,timeLabel);return row;
}

async function loadPlanning(scope,id,initial=null){
  const data=initial||await api(planningPath(scope,id));
  if(planningOwner(scope)!==id)return;
  if(scope==='book'&&planningBookView.ownerId!==id){
    planningBookView.ownerId=id;planningBookView.openBlocks.clear();planningBookView.editBlocks.clear();planningBookView.openCards.clear();
  }
  planningState[scope]={id,...data};
  renderPlanning(scope);
}

function queuePlanning(scope,id,blockId,patch){
  planningQueue[scope]=planningQueue[scope].catch(()=>{}).then(async()=>{
    try{
      const data=await api(`${planningPath(scope,id)}${blockId?`/${blockId}`:''}`,'POST',patch);
      if(planningOwner(scope)!==id)return;
      planningState[scope]={id,...data};
      if(scope==='experiment'&&current?.id===id){current.planning=data;current.updated_at=data.updated_at;$('updated-at').textContent=`마지막 저장 ${new Date(data.updated_at).toLocaleString('ko-KR')}`}
      return data;
    }catch(error){toast(error.message);return null}
  });
  return planningQueue[scope];
}

async function flushPlanning(scope){
  if(scope==='book')await flushBookPlanningForms();
  const state=planningState[scope];if(!state||planningOwner(scope)!==state.id||planningLocked(scope))return;
  for(const element of planningPanel(scope).querySelectorAll('.planning-block')){
    const item=state.blocks.find(block=>block.id===element.dataset.id);if(!item)continue;
    const title=element.querySelector('.planning-title').value.trim();
    const content=element.querySelector('.planning-content').value;
    const patch={};if(title&&title!==item.title)patch.title=title;
    if(content!==item.content)patch.content=content;
    if(scope==='experiment'){
      const date=element.querySelector('.planning-timing input[type=date]').value;
      const time=element.querySelector('.planning-timing input[type=time]').value;
      const event_at=planningEventValue(date,time);
      if(event_at!==item.event_at)patch.event_at=event_at;
    }
    if(Object.keys(patch).length&&!await queuePlanning(scope,state.id,item.id,patch))throw new Error('설계 내용을 저장하지 못했습니다.');
  }
  await planningQueue[scope];
}

function renderPlanning(scope){
  const state=planningState[scope],panel=planningPanel(scope);
  if(!state||planningOwner(scope)!==state.id)return;
  const locked=planningLocked(scope),body=panel.querySelector('.planning-body'),canvas=panel.querySelector('.planning-canvas');
  const toggle=panel.querySelector('.planning-toggle');
  body.hidden=state.collapsed;toggle.textContent=state.collapsed?'펼치기':'접기';toggle.setAttribute('aria-expanded',String(!state.collapsed));
  toggle.onclick=async()=>{await saveBookFormBeforeAction(scope);if(locked){state.collapsed=!state.collapsed}else await queuePlanning(scope,state.id,null,{collapsed:!state.collapsed});renderPlanning(scope)};
  canvas.replaceChildren();
  for(const item of state.blocks.filter(block=>!block.removed)){
    const block=document.createElement('section');block.className='planning-block';block.dataset.id=item.id;
    const bookOpen=scope!=='book'||planningBookView.openBlocks.has(item.id);
    if(scope==='book')block.classList.toggle('is-closed',!bookOpen);
    const head=document.createElement('div');head.className='planning-block-head';
    const drag=document.createElement('button');drag.type='button';drag.className='planning-drag';drag.textContent='⠿';drag.title='끌어서 이동 · 방향키로 조정';drag.setAttribute('aria-label',`${item.title} 블록 이동`);
    const title=document.createElement('input');title.className='planning-title';title.value=item.title;title.maxLength=160;title.setAttribute('aria-label','설계 블록 제목');title.readOnly=locked;
    const ai=document.createElement('button');ai.type='button';ai.className=`planning-ai ${item.ai_allowed?'allowed':'locked'}`;ai.textContent=item.ai_allowed?'🏠':'🔒';ai.title=item.ai_allowed?'로컬 AI 허용 · 눌러서 금지':'AI 사용 금지 · 눌러서 로컬 AI 허용';ai.setAttribute('aria-label',`${item.title} ${item.ai_allowed?'로컬 AI 허용':'AI 사용 금지'}`);ai.disabled=locked;
    const remove=document.createElement('button');remove.type='button';remove.className='planning-remove';remove.textContent='×';remove.title='블록 숨기기 · 아래에서 복원 가능';remove.setAttribute('aria-label',`${item.title} 블록 숨기기`);
    if(scope==='book'){
      const heading=document.createElement('div');heading.className='planning-book-heading';
      const status=document.createElement('span');status.className='planning-book-status';status.textContent=bookPlanningStatus(item);
      const expand=document.createElement('button');expand.type='button';expand.className='planning-block-toggle';expand.textContent=bookOpen?'접기':'펼치기';expand.setAttribute('aria-label',`${item.title} ${bookOpen?'접기':'펼치기'}`);expand.setAttribute('aria-expanded',String(bookOpen));
      expand.onclick=async()=>{await flushPlanning('book');if(bookOpen){planningBookView.openBlocks.delete(item.id);planningBookView.editBlocks.delete(item.id);planningBookView.openCards.delete(item.id)}else planningBookView.openBlocks.add(item.id);renderPlanning('book')};
      heading.append(title,status);head.append(drag,heading,expand,ai,remove);
    }else head.append(drag,title,ai,remove);
    const content=document.createElement('textarea');content.className='planning-content';content.value=item.content;content.placeholder='생각과 근거, 자료를 자유롭게 적어 주세요.';content.setAttribute('aria-label',`${item.title} 내용`);content.readOnly=locked;
    let timing=null;
    if(scope==='experiment'){
      timing=document.createElement('div');timing.className='planning-timing';
      const dateLabel=document.createElement('label');dateLabel.textContent='실제 날짜';const date=document.createElement('input');date.type='date';date.value=planningDate(item.event_at);date.disabled=locked;dateLabel.append(date);
      const timeLabel=document.createElement('label');timeLabel.textContent='시간 (선택)';const time=document.createElement('input');time.type='time';time.value=planningTime(item.event_at);time.disabled=locked;timeLabel.append(time);
      timing.append(dateLabel,timeLabel);
      const saveTime=()=>{const value=planningEventValue(date.value,time.value);if(value!==item.event_at)queuePlanning(scope,state.id,item.id,{event_at:value})};
      date.onchange=saveTime;time.onchange=saveTime;
    }
    const resize=document.createElement('button');resize.type='button';resize.className='planning-resize';resize.textContent='◢';resize.title='끌어서 크기 조절 · 두 번 클릭하면 높이 자동';resize.setAttribute('aria-label',`${item.title} 크기 조절`);
    block.append(head);
    if(scope==='book'){
      const bookBody=document.createElement('div');bookBody.className='planning-block-body';bookBody.hidden=!bookOpen;
      if(item.form?.mode){
        const edit=planningFormButton(planningBookView.editBlocks.has(item.id)?'양식 편집 완료':'양식 편집',async()=>{
          await flushPlanning('book');
          if(planningBookView.editBlocks.has(item.id))planningBookView.editBlocks.delete(item.id);
          else{planningBookView.editBlocks.add(item.id);if(item.form.mode==='repeat'&&!planningBookView.openCards.has(item.id))planningBookView.openCards.set(item.id,item.form.groups[0]?.id)}
          renderPlanning('book');
        },'planning-edit-toggle');edit.disabled=locked;
        bookBody.append(edit,renderBookPlanningForm(block,item,locked));
        const extra=document.createElement('details');extra.className='planning-extra';extra.open=Boolean(item.content.trim());
        const summary=document.createElement('summary');summary.textContent='기존·추가 자유 메모';extra.append(summary,content);bookBody.append(extra);
      }else bookBody.append(content);
      block.append(bookBody);
    }else{block.append(content);if(timing)block.append(timing)}
    block.append(resize);canvas.append(block);renderReferenceLinks(block,content);
    content.style.height='auto';content.style.height=`${Math.max(100,content.scrollHeight)}px`;
    content.oninput=()=>{content.style.height='auto';content.style.height=`${Math.max(100,content.scrollHeight)}px`;renderReferenceLinks(block,content);if(scope==='book')updateBookPlanningStatus(block);layoutPlanning(scope)};
    title.onblur=()=>{if(title.value.trim()&&title.value.trim()!==item.title)queuePlanning(scope,state.id,item.id,{title:title.value.trim()})};
    content.onblur=()=>{if(content.value!==item.content)queuePlanning(scope,state.id,item.id,{content:content.value})};
    ai.onclick=async()=>{await saveBookFormBeforeAction(scope);await queuePlanning(scope,state.id,item.id,{ai_allowed:!Boolean(item.ai_allowed)});renderPlanning(scope)};
    remove.onclick=async()=>{await saveBookFormBeforeAction(scope);await queuePlanning(scope,state.id,item.id,{removed:1});renderPlanning(scope)};
    drag.disabled=remove.disabled=locked||!bookOpen;resize.disabled=locked||!bookOpen;
    if(!locked){wirePlanningPointer(scope,block,drag,'move');wirePlanningPointer(scope,block,resize,'resize');drag.onkeydown=event=>{
      const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-20],ArrowDown:[0,20]}[event.key];if(!delta)return;
      event.preventDefault();
      if(scope==='book'&&delta[1]){
        const order=state.blocks.filter(entry=>!entry.removed).sort((a,b)=>a.pos_y-b.pos_y||a.sort_order-b.sort_order).map(entry=>entry.id);
        const index=order.indexOf(item.id),next=Math.max(0,Math.min(order.length-1,index+(delta[1]>0?1:-1)));
        if(index!==next){[order[index],order[next]]=[order[next],order[index]];saveBookPlanningOrder(state,order).catch(error=>toast(error.message))}
        return;
      }
      const x=Math.max(0,Math.min(100-item.width,item.pos_x+delta[0]));
      const patch=scope==='book'?{pos_x:x}:{pos_x:x,pos_y:Math.max(0,item.pos_y+delta[1])};
      saveBookFormBeforeAction(scope).then(()=>queuePlanning(scope,state.id,item.id,patch)).then(()=>renderPlanning(scope)).catch(error=>toast(error.message));
    };resize.ondblclick=()=>saveBookFormBeforeAction(scope).then(()=>queuePlanning(scope,state.id,item.id,{min_height:0})).then(()=>renderPlanning(scope))}
  }
  const restore=panel.querySelector('.planning-restore');restore.replaceChildren();
  for(const item of state.blocks.filter(block=>block.removed)){
    const button=document.createElement('button');button.type='button';button.className='text-button';button.textContent=`＋ ${item.title} 복원`;button.disabled=locked;
    button.onclick=async()=>{await saveBookFormBeforeAction(scope);await queuePlanning(scope,state.id,item.id,{removed:0});renderPlanning(scope)};restore.append(button);
  }
  const add=panel.querySelector('.planning-add');add.disabled=locked;
  add.onclick=async()=>{const title=window.prompt('새 설계 블록의 제목',scope==='book'?'새 연구 메모':'새 실험 설계 메모');if(!title?.trim())return;await saveBookFormBeforeAction(scope);const saved=await queuePlanning(scope,state.id,null,{title:title.trim()});if(scope==='book'&&saved?.blocks?.length)planningBookView.openBlocks.add(saved.blocks.at(-1).id);renderPlanning(scope);canvas.lastElementChild?.querySelector('.planning-content')?.focus()};
  requestAnimationFrame(()=>{
    if(scope==='book')for(const textarea of canvas.querySelectorAll('.planning-field-value:is(textarea)')){
      textarea.style.height='auto';textarea.style.height=`${Math.max(58,textarea.scrollHeight)}px`;
    }
    layoutPlanning(scope);
  });
}

function layoutPlanning(scope,preview=null){
  const state=planningState[scope],canvas=planningPanel(scope).querySelector('.planning-canvas');
  if(!state||!canvas.clientWidth)return;
  const entries=state.blocks.filter(item=>!item.removed).map((item,index)=>{
    const block=canvas.querySelector(`[data-id="${item.id}"]`),data=preview?.id===item.id?{...item,...preview}:item;
    if(!block)return null;
    block.style.width=`calc(${data.width}% - 10px)`;block.style.minHeight=`${scope==='book'&&block.classList.contains('is-closed')?0:data.min_height}px`;
    return {block,data,index,height:block.getBoundingClientRect().height};
  }).filter(Boolean).sort((a,b)=>a.data.pos_y-b.data.pos_y||a.index-b.index);
  const placed=[];
  for(const entry of entries){
    let y=scope==='book'?0:entry.data.pos_y;
    for(const other of placed)if(entry.data.pos_x<other.data.pos_x+other.data.width&&entry.data.pos_x+entry.data.width>other.data.pos_x&&y<other.y+other.height+10&&y+entry.height+10>other.y)y=other.y+other.height+10;
    entry.block.style.left=`calc(${entry.data.pos_x}% + 5px)`;entry.block.style.top=`${y}px`;
    placed.push({...entry,y});
  }
  canvas.style.height=`${Math.max(0,...placed.map(entry=>entry.y+entry.height))+8}px`;
}

async function saveBookPlanningOrder(state,orderedIds,movedId=null,movedX=null){
  await flushPlanning('book');
  for(const [index,id] of orderedIds.entries()){
    const item=planningState.book?.blocks.find(block=>block.id===id);if(!item)continue;
    const patch={};
    if(item.pos_y!==(index+1)*100)patch.pos_y=(index+1)*100;
    if(id===movedId&&movedX!==null&&item.pos_x!==movedX)patch.pos_x=movedX;
    if(Object.keys(patch).length&&!await queuePlanning('book',state.id,id,patch))throw new Error('설계 블록 순서를 저장하지 못했습니다.');
  }
  renderPlanning('book');
}

function wirePlanningPointer(scope,block,handle,mode){
  handle.addEventListener('pointerdown',event=>{
    if(event.button!==0||matchMedia('(max-width:700px)').matches)return;
    const state=planningState[scope],item=state.blocks.find(value=>value.id===block.dataset.id),canvas=planningPanel(scope).querySelector('.planning-canvas');
    const start={x:event.clientX,y:event.clientY,width:item.width,min_height:item.min_height,pos_x:item.pos_x,pos_y:block.offsetTop,height:block.getBoundingClientRect().height};
    let patch=null;event.preventDefault();handle.setPointerCapture(event.pointerId);block.classList.add('planning-moving');
    const move=e=>{
      const dx=e.clientX-start.x,dy=e.clientY-start.y;if(Math.abs(dx)+Math.abs(dy)<3)return;
      if(mode==='move')patch={pos_x:Math.max(0,Math.min(100-start.width,Math.round(start.pos_x+dx/canvas.clientWidth*100))),pos_y:Math.max(0,Math.min(20000,Math.round(start.pos_y+dy)))};
      else{const width=Math.max(20,Math.min(100-start.pos_x,Math.round(start.width+dx/canvas.clientWidth*100)));patch={width,min_height:Math.max(0,Math.min(4000,Math.round(start.height+dy)))}}
      if(scope==='book'&&mode==='move'){
        block.style.left=`calc(${patch.pos_x}% + 5px)`;block.style.top=`${patch.pos_y}px`;
      }else layoutPlanning(scope,{id:item.id,...patch});
    };
    const finish=()=>{
      handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',finish);handle.removeEventListener('pointercancel',cancel);block.classList.remove('planning-moving');
      if(!patch){layoutPlanning(scope);return}
      if(scope==='book'&&mode==='move'){
        const others=[...canvas.querySelectorAll('.planning-block')].filter(other=>other!==block).sort((a,b)=>a.offsetTop-b.offsetTop||a.offsetLeft-b.offsetLeft);
        const center=patch.pos_y+block.getBoundingClientRect().height/2;
        const before=others.findIndex(other=>center<other.offsetTop+other.getBoundingClientRect().height/2);
        const order=others.map(other=>other.dataset.id);order.splice(before<0?order.length:before,0,item.id);
        saveBookPlanningOrder(state,order,item.id,patch.pos_x).catch(error=>toast(error.message));
      }else saveBookFormBeforeAction(scope).then(()=>queuePlanning(scope,state.id,item.id,patch)).then(()=>renderPlanning(scope)).catch(error=>toast(error.message));
    };
    const cancel=()=>{handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',finish);handle.removeEventListener('pointercancel',cancel);block.classList.remove('planning-moving');layoutPlanning(scope)};
    handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',cancel);
  });
}

window.addEventListener('resize',()=>{layoutPlanning('book');layoutPlanning('experiment')});
