/* Plain-text lists keep the existing storage, export and AI access format. */
function listLineParts(line){
  const match=line.match(/^([ \t]*)(?:(•|[-*+]|\d+[.)])([ \t]+))?(.*)$/);
  return {indent:match[1],marker:match[2]||'',space:match[3]||'',body:match[4]};
}
function formatNoteLines(value,start,end,action){
  const first=start===0?0:value.lastIndexOf('\n',start-1)+1;
  const lastPosition=end>start&&value[end-1]==='\n'?end-1:end;
  const newline=value.indexOf('\n',lastPosition),last=newline<0?value.length:newline;
  const lines=value.slice(first,last).split('\n'),parts=lines.map(listLineParts);
  const numbered=p=>/^\d+[.)]$/.test(p.marker);
  const remove=action==='bullet'?parts.every(p=>p.marker&&!numbered(p)):action==='number'?parts.every(numbered):false;
  const counts=new Map();
  const replacements=parts.map((p,index)=>{
    if(action==='indent')return {oldPrefix:'',newPrefix:'  ',line:'  '+lines[index]};
    if(action==='outdent'){
      const prefix=lines[index].match(/^(?:\t| {1,2})/)?.[0]||'';
      return {oldPrefix:prefix,newPrefix:'',line:lines[index].slice(prefix.length)};
    }
    const oldPrefix=p.indent+p.marker+p.space;
    let marker='';
    if(!remove){
      if(action==='bullet')marker='• ';
      else{const count=(counts.get(p.indent)||0)+1;counts.set(p.indent,count);marker=`${count}. `}
    }
    const newPrefix=p.indent+marker;
    return {oldPrefix,newPrefix,line:newPrefix+p.body};
  });
  const text=replacements.map(r=>r.line).join('\n');
  const mapPosition=position=>{
    let oldOffset=first,newOffset=first;
    for(let i=0;i<lines.length;i++){
      const r=replacements[i],lineEnd=oldOffset+lines[i].length;
      if(position<=lineEnd){
        const column=position-oldOffset;
        return newOffset+(column<=r.oldPrefix.length?r.newPrefix.length:column-r.oldPrefix.length+r.newPrefix.length);
      }
      oldOffset=lineEnd+1;newOffset+=r.line.length+1;
    }
    return first+text.length;
  };
  return {start:first,end:last,text,selectionStart:mapPosition(start),selectionEnd:mapPosition(Math.min(end,last))};
}
function continueNoteLine(value,start,end){
  const lineStart=start===0?0:value.lastIndexOf('\n',start-1)+1;
  const newline=value.indexOf('\n',start),lineEnd=newline<0?value.length:newline;
  const p=listLineParts(value.slice(lineStart,lineEnd)),prefix=p.indent+p.marker+p.space;
  if(start-lineStart<prefix.length)return null;
  if(p.marker&&start===end&&!p.body.trim())return {start:lineStart,end:lineEnd,text:''};
  if(!p.marker&&!p.indent)return null;
  const marker=/^\d+[.)]$/.test(p.marker)?`${Number.parseInt(p.marker,10)+1}${p.marker.at(-1)}`:p.marker;
  return {start,end,text:'\n'+p.indent+marker+(marker?p.space:'')};
}
function applyNoteEdit(textarea,edit){
  if(!edit||textarea.readOnly)return;
  const before=textarea.value;
  if(before.slice(edit.start,edit.end)===edit.text)return;
  textarea.focus({preventScroll:true});textarea.setSelectionRange(edit.start,edit.end);
  // insertText retains Chromium's native undo stack.
  const inserted=document.execCommand('insertText',false,edit.text);
  if(!inserted&&textarea.value===before){textarea.setRangeText(edit.text,edit.start,edit.end,'end');textarea.dispatchEvent(new Event('input',{bubbles:true}))}
  const cursor=edit.start+edit.text.length;
  textarea.setSelectionRange(edit.selectionStart??cursor,edit.selectionEnd??cursor);
}
function attachNoteEditor(textarea){
  const toolbar=document.createElement('div');toolbar.className='note-editor-toolbar';toolbar.setAttribute('role','group');toolbar.setAttribute('aria-label','기록 서식');
  for(const [action,label,title] of [['bullet','• 목록','글머리 기호 목록'],['number','1. 목록','번호 목록'],['outdent','⇤','내어쓰기 (Shift+Tab)'],['indent','⇥','들여쓰기 (Tab)']]){
    const button=document.createElement('button');button.type='button';button.dataset.format=action;button.textContent=label;button.title=title;button.setAttribute('aria-label',title);button.disabled=textarea.readOnly;
    button.onmousedown=event=>event.preventDefault();
    button.onclick=()=>{if(!textarea.readOnly)applyNoteEdit(textarea,formatNoteLines(textarea.value,textarea.selectionStart,textarea.selectionEnd,action))};toolbar.append(button);
  }
  const hint=document.createElement('span');hint.textContent='Enter 다음 항목 · Tab 들여쓰기';hint.title='빈 목록에서 Enter: 목록 끝내기 / Esc 다음 Tab: 입력칸 밖으로 이동';toolbar.append(hint);
  textarea.before(toolbar);
  let composing=false,escapeTab=false;
  textarea.addEventListener('compositionstart',()=>{composing=true});textarea.addEventListener('compositionend',()=>{composing=false});
  textarea.addEventListener('keydown',event=>{
    if(textarea.readOnly||composing||event.isComposing||event.keyCode===229)return;
    if(event.key==='Escape'){escapeTab=true;return}
    if(event.key==='Tab'&&escapeTab){escapeTab=false;return}
    escapeTab=false;
    if(event.ctrlKey||event.metaKey||event.altKey)return;
    if(event.key==='Tab'){
      event.preventDefault();applyNoteEdit(textarea,formatNoteLines(textarea.value,textarea.selectionStart,textarea.selectionEnd,event.shiftKey?'outdent':'indent'));
    }else if(event.key==='Enter'&&!event.shiftKey){
      const edit=continueNoteLine(textarea.value,textarea.selectionStart,textarea.selectionEnd);
      if(edit){event.preventDefault();applyNoteEdit(textarea,edit)}
    }
  });
}
