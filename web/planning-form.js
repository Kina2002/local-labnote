/* Editable fields inside book-wide research design blocks. */
const planningFormTimers=new Map();
const planningFormId=()=>crypto.randomUUID().replaceAll('-','');

function planningFormValue(block,model){
  const oldFields=new Map(model.groups.flatMap(group=>group.fields.map(field=>[field.id,field])));
  const formElement=block.querySelector(':scope > .planning-block-body > .planning-form');
  const groups=[...formElement.querySelectorAll(':scope > .planning-form-group')];
  if(model.groups.length&&!groups.length)throw new Error('연구 설계 양식 화면을 읽지 못했습니다.');
  return {mode:model.mode,repeat_label:model.repeat_label,template:model.template.map(field=>({...field})),
    groups:groups.map(group=>({
      id:group.dataset.id,
      title:group.querySelector('.planning-group-title')?.value.trim()||'',
      fields:[...group.querySelectorAll('.planning-form-fields > .planning-form-field')].map(field=>({
        id:field.dataset.id,
        label:(field.querySelector('.planning-field-label')?.value||field.dataset.label||'').trim()||oldFields.get(field.dataset.id)?.label||'새 항목',
        kind:field.querySelector('.planning-field-kind')?.value||field.dataset.kind,
        value:field.querySelector('.planning-field-value').value,
      })),
    }))};
}

async function savePlanningFormElement(block){
  if(!block.isConnected||planningOwner('book')!==planningState.book?.id)return true;
  const item=planningState.book.blocks.find(entry=>entry.id===block.dataset.id);
  if(!item?.form?.mode)return true;
  const form=planningFormValue(block,item.form);
  if(JSON.stringify(form)===JSON.stringify(item.form))return true;
  return Boolean(await queuePlanning('book',planningState.book.id,item.id,{form}));
}

function schedulePlanningFormSave(block){
  clearTimeout(planningFormTimers.get(block.dataset.id));
  planningFormTimers.set(block.dataset.id,setTimeout(()=>{
    planningFormTimers.delete(block.dataset.id);
    savePlanningFormElement(block);
  },450));
}

async function flushBookPlanningForms(){
  const blocks=[...planningPanel('book').querySelectorAll('.planning-block:has(.planning-form)')];
  for(const block of blocks){
    clearTimeout(planningFormTimers.get(block.dataset.id));planningFormTimers.delete(block.dataset.id);
    if(!await savePlanningFormElement(block))throw new Error('연구 설계 양식을 저장하지 못했습니다.');
  }
  await planningQueue.book;
}

async function editPlanningForm(block,change){
  clearTimeout(planningFormTimers.get(block.dataset.id));planningFormTimers.delete(block.dataset.id);
  const state=planningState.book,item=state?.blocks.find(entry=>entry.id===block.dataset.id);
  if(!item?.form?.mode||planningOwner('book')!==state.id)return;
  const form=planningFormValue(block,item.form);
  change(form);
  const saved=await queuePlanning('book',state.id,item.id,{form});
  if(saved)renderPlanning('book');
}

function planningFormButton(label,action,className='subtle-button'){
  const button=document.createElement('button');button.type='button';button.className=className;button.textContent=label;button.onclick=action;return button;
}
function planningCardSummary(fields){
  const filled=fields.map(field=>field.value.trim().replace(/\s+/g,' ')).filter(Boolean);
  if(!filled.length)return '미작성';
  const first=filled[0].length>54?`${filled[0].slice(0,54)}…`:filled[0];
  return filled.length>1?`${first} · ${filled.length}칸 작성`:first;
}

function renderBookPlanningForm(block,item,locked){
  const model=item.form,editing=planningBookView.editBlocks.has(item.id)&&!locked;
  const form=document.createElement('div');form.className=`planning-form planning-form-${model.mode}${editing?' is-editing':''}`;
  for(const group of model.groups){
    const groupBox=document.createElement('div');groupBox.className='planning-form-group';groupBox.dataset.id=group.id;
    let groupContent=groupBox,preview=null;
    if(model.mode==='repeat'){
      const header=document.createElement('div');header.className='planning-form-group-head';
      const open=planningBookView.openCards.get(item.id)===group.id;
      const toggle=planningFormButton(group.title||`${model.repeat_label} 카드`,async()=>{
        await flushBookPlanningForms();
        if(open)planningBookView.openCards.delete(item.id);else planningBookView.openCards.set(item.id,group.id);
        renderPlanning('book');
      },'planning-group-toggle');toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-label',`${group.title||model.repeat_label} ${open?'접기':'펼치기'}`);
      preview=document.createElement('span');preview.className='planning-group-preview';preview.textContent=planningCardSummary(group.fields);
      const arrow=document.createElement('span');arrow.className='planning-group-arrow';arrow.textContent=open?'⌃':'⌄';arrow.setAttribute('aria-hidden','true');
      header.append(toggle,preview,arrow);groupBox.append(header);
      groupContent=document.createElement('div');groupContent.className='planning-form-group-body';groupContent.hidden=!open;
      const titleRow=document.createElement('div');titleRow.className='planning-group-title-row';
      const titleLabel=document.createElement('label');titleLabel.textContent='카드 제목';titleLabel.className='planning-group-title-label';
      const title=document.createElement('input');title.className='planning-group-title';title.value=group.title;title.maxLength=100;title.placeholder=`${model.repeat_label} 제목`;title.setAttribute('aria-label',`${model.repeat_label} 카드 제목`);title.readOnly=locked;
      title.oninput=()=>{toggle.textContent=title.value||`${model.repeat_label} 카드`;schedulePlanningFormSave(block)};
      titleRow.append(titleLabel,title);
      if(editing){
        const remove=planningFormButton('카드 삭제',()=>editPlanningForm(block,draft=>{
          const target=draft.groups.find(entry=>entry.id===group.id);
          if(target?.fields.some(field=>field.value.trim())&&!confirm('이 카드에 적은 내용도 함께 삭제됩니다. 계속할까요?'))return;
          draft.groups=draft.groups.filter(entry=>entry.id!==group.id);
          if(planningBookView.openCards.get(item.id)===group.id)planningBookView.openCards.delete(item.id);
        }),'planning-form-remove');remove.disabled=locked;titleRow.append(remove);
      }
      groupContent.append(titleRow);
    }
    const fields=document.createElement('div');fields.className='planning-form-fields';
    for(const field of group.fields){
      const row=document.createElement('div');row.className='planning-form-field';row.dataset.id=field.id;row.dataset.label=field.label;row.dataset.kind=field.kind;
      const head=document.createElement('div');head.className='planning-form-field-head';
      const value=document.createElement(field.kind==='long'?'textarea':'input');value.className='planning-field-value';value.id=`planning-field-${field.id}`;value.value=field.value;value.maxLength=10000;value.placeholder='아직 모르면 비워 두거나 확인할 점을 적어 주세요.';value.setAttribute('aria-label',field.label);value.readOnly=locked;
      if(editing){
        const label=document.createElement('input');label.className='planning-field-label';label.value=field.label;label.maxLength=100;label.placeholder='입력칸 이름';label.setAttribute('aria-label','입력칸 이름');label.oninput=()=>{row.dataset.label=label.value;value.setAttribute('aria-label',label.value);schedulePlanningFormSave(block)};
        const kind=document.createElement('select');kind.className='planning-field-kind';kind.setAttribute('aria-label',`${field.label} 입력 방식`);kind.add(new Option('짧은 글','short'));kind.add(new Option('긴 글','long'));kind.value=field.kind;
        kind.onchange=()=>editPlanningForm(block,()=>{});
        const remove=planningFormButton('×',()=>editPlanningForm(block,draft=>{
          const target=draft.groups.find(entry=>entry.id===group.id);
          const fieldToRemove=target?.fields.find(entry=>entry.id===field.id);
          if(fieldToRemove?.value.trim()&&!confirm('이 입력칸에 적은 내용도 함께 삭제됩니다. 계속할까요?'))return;
          if(target)target.fields=target.fields.filter(entry=>entry.id!==field.id);
        }),'planning-form-remove');remove.title='입력칸 삭제';remove.setAttribute('aria-label',`${field.label} 입력칸 삭제`);
        head.append(label,kind,remove);
      }else{
        const label=document.createElement('label');label.className='planning-field-name';label.textContent=field.label;label.htmlFor=value.id;head.append(label);
      }
      row.append(head);
      value.oninput=()=>{if(value.tagName==='TEXTAREA'){value.style.height='auto';value.style.height=`${Math.max(58,value.scrollHeight)}px`}renderReferenceLinks(row,value);if(preview)preview.textContent=planningCardSummary([...groupBox.querySelectorAll('.planning-field-value')].map(input=>({value:input.value})));updateBookPlanningStatus(block);layoutPlanning('book');schedulePlanningFormSave(block)};
      row.append(value);fields.append(row);if(value.tagName==='TEXTAREA'){value.style.height='auto';value.style.height=`${Math.max(58,value.scrollHeight)}px`}
      renderReferenceLinks(row,value);
    }
    groupContent.append(fields);
    if(editing){
      const addField=planningFormButton('＋ 입력칸 추가',()=>editPlanningForm(block,draft=>{
        const target=draft.groups.find(entry=>entry.id===group.id);
        if(target)target.fields.push({id:planningFormId(),label:'새 항목',kind:'long',value:''});
      }),'planning-form-add');addField.disabled=group.fields.length>=30;groupContent.append(addField);
    }
    if(model.mode==='repeat')groupBox.append(groupContent);
    form.append(groupBox);
  }
  if(model.mode==='repeat'){
    const addGroup=planningFormButton(`＋ ${model.repeat_label} 추가`,()=>editPlanningForm(block,draft=>{
      const source=draft.groups.at(-1)?.fields.map(field=>({label:field.label,kind:field.kind}))||draft.template;
      const id=planningFormId();draft.groups.push({id,title:`${draft.repeat_label} ${draft.groups.length+1}`,
        fields:source.map(field=>({id:planningFormId(),label:field.label,kind:field.kind,value:''}))});
      planningBookView.openCards.set(item.id,id);
    }),'planning-form-add-group');addGroup.disabled=locked||model.groups.length>=40;form.append(addGroup);
  }else if(!model.groups.length&&editing){
    const addGroup=planningFormButton('＋ 입력칸 묶음 만들기',()=>editPlanningForm(block,draft=>{
      draft.groups.push({id:planningFormId(),title:'',fields:[{id:planningFormId(),label:'새 항목',kind:'long',value:''}]});
    }),'planning-form-add-group');addGroup.disabled=locked;form.append(addGroup);
  }
  return form;
}
