let imageChangeQueue=Promise.resolve();
function applyImageLayout(item,width,alignment){
  const frame=item.querySelector('.image-preview,.panel-comparison');if(!frame)return;
  frame.style.width=`${width}%`;frame.style.justifySelf=alignment==='left'?'start':alignment==='right'?'end':'center';
}
function changeImageLayout(file,patch){
  const experimentId=current.id;
  imageChangeQueue=imageChangeQueue.catch(()=>{}).then(async()=>{
    if(current?.id!==experimentId)return;
    try{
      await persistRecordEdits();
      if(current?.id!==experimentId)return;
      const saved=await api(`/api/attachments/${file.id}/layout`,'POST',patch);
      if(current?.id!==experimentId)return;
      current=saved;renderSections();
      if(!('removed' in patch))document.querySelector(`[data-image-settings="${file.id}"]`)?.setAttribute('open','');
      toast(patch.removed?'그림을 삭제했습니다. 아래 ‘삭제한 그림’에서 복원할 수 있어요.':'removed' in patch?'그림을 복원했습니다. 🔒 AI 사용 금지로 보관됩니다.':'그림 배치를 저장했습니다.');
    }catch(error){toast(error.message)}
  });
  return imageChangeQueue;
}
function attachImageLayout(item,file){
  applyImageLayout(item,file.display_width||100,file.display_align||'center');
  if(current.archived)return;
  const bar=document.createElement('div');bar.className='image-layout-bar';
  if(file.editable_drawing){const edit=document.createElement('button');edit.type='button';edit.className='continue-drawing';edit.textContent='이어서 그리기';edit.onclick=()=>openDrawing('edit',file.section_key,file,file.block_id);bar.append(edit)}
  const details=document.createElement('details');details.className='image-layout-settings';details.dataset.imageSettings=file.id;
  const summary=document.createElement('summary');summary.textContent='배치·크기';details.append(summary);
  const controls=document.createElement('div');controls.className='image-layout-controls';
  const widthLabel=document.createElement('label');widthLabel.textContent='너비 ';
  const width=document.createElement('input');width.type='range';width.min='25';width.max='100';width.step='5';width.value=file.display_width||100;width.setAttribute('aria-label','그림 너비');
  const output=document.createElement('output');output.textContent=`${width.value}%`;
  width.oninput=()=>{output.textContent=`${width.value}%`;applyImageLayout(item,width.value,file.display_align||'center')};
  width.onchange=()=>changeImageLayout(file,{width:Number(width.value)});widthLabel.append(width,output);controls.append(widthLabel);
  const select=(label,options,value,callback)=>{const wrap=document.createElement('label');wrap.textContent=label;const field=document.createElement('select');field.setAttribute('aria-label',label);for(const [key,text]of options){const option=document.createElement('option');option.value=key;option.textContent=text;field.append(option)}field.value=value;field.onchange=()=>callback(field.value);wrap.append(field);controls.append(wrap)};
  select('그림 정렬',[['left','왼쪽'],['center','가운데'],['right','오른쪽']],file.display_align||'center',alignment=>changeImageLayout(file,{alignment}));
  select('본문 기준 위치',[['before','본문 위'],['after','본문 아래']],file.display_placement||'after',placement=>changeImageLayout(file,{placement}));
  const order=document.createElement('div');order.className='image-order-controls';
  const siblings=current.attachments.filter(f=>f.section_key===file.section_key&&f.block_id===file.block_id&&f.mime_type.startsWith('image/')&&f.display_placement===file.display_placement),index=siblings.findIndex(f=>f.id===file.id);
  for(const [direction,label]of [[-1,'↑ 앞 그림으로'],[1,'↓ 뒤 그림으로']]){const button=document.createElement('button');button.type='button';button.textContent=label;button.disabled=direction<0?index<=0:index===siblings.length-1;button.onclick=()=>changeImageLayout(file,{move:direction});order.append(button)}
  controls.append(order);details.append(controls);bar.append(details);
  const remove=document.createElement('button');remove.type='button';remove.className='remove-image';remove.textContent='삭제';remove.setAttribute('aria-label',`${file.original_name} 그림 삭제`);remove.onclick=()=>{remove.disabled=true;changeImageLayout(file,{removed:true}).finally(()=>remove.disabled=false)};bar.append(remove);item.append(bar);
}
function appendRemovedImages(block,key,blockId=null){
  const files=(current.removed_attachments||[]).filter(f=>blockId?f.block_id===blockId:f.section_key===key&&!f.block_id);if(!files.length)return;
  const details=document.createElement('details');details.className='removed-images';const summary=document.createElement('summary');summary.textContent=`삭제한 그림 ${files.length}개`;details.append(summary);
  const note=document.createElement('p');note.textContent='노트에서 삭제된 그림입니다. 복원을 위해 파일은 이 컴퓨터에 보관됩니다.';details.append(note);
  for(const file of files){const row=document.createElement('div'),name=document.createElement('span'),restore=document.createElement('button');name.textContent=file.original_name;restore.textContent='복원';restore.type='button';restore.disabled=Boolean(current.archived);restore.onclick=()=>changeImageLayout(file,{removed:false});row.append(name,restore);details.append(row)}block.append(details);
}
