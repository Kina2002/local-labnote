/* Local, structured drawings. No AI, CDN or external service is involved. */
let drawingSession=null;
const drawingClone=value=>JSON.parse(JSON.stringify(value));
function ensureDrawingDialog(){
  if(document.getElementById('drawing-dialog'))return;
  const dialog=document.createElement('dialog');dialog.id='drawing-dialog';dialog.className='drawing-dialog';dialog.setAttribute('aria-labelledby','drawing-title');
  dialog.innerHTML=`<header class="drawing-head"><h2 id="drawing-title">그림 추가</h2><button id="drawing-close" aria-label="그림 편집 닫기">닫기 ×</button></header>
    <div class="drawing-choice" id="drawing-choice"><button data-mode="molecule"><strong>분자구조</strong><span>원자와 결합, 고리를 조합해 그려요.</span></button><button data-mode="sketch"><strong>간단한 스케치</strong><span>손그림·화살표·설명으로 남겨요.</span></button></div>
    <div class="drawing-editor" id="drawing-editor" hidden>
    <div class="drawing-toolbar" role="toolbar" aria-label="그림 도구">
      <div class="drawing-toolset" id="drawing-chem-tools"><button data-tool="bond" aria-pressed="false">결합</button><select id="drawing-bond" aria-label="결합 종류"><option value="1">단일결합</option><option value="2">이중결합</option><option value="3">삼중결합</option></select><button data-tool="atom" aria-pressed="false">원자</button><select id="drawing-element" aria-label="원자 종류">${['C','N','O','S','P','F','Cl','Br','I','H','Si','B','R'].map(e=>`<option>${e}</option>`).join('')}</select><button data-tool="ring" aria-pressed="false">고리</button><select id="drawing-ring" aria-label="고리 종류"><option value="6">육각고리</option><option value="benzene">벤젠고리</option><option value="5">오각고리</option></select></div>
      <div class="drawing-toolset"><button id="drawing-pen" data-tool="pen" aria-pressed="false">펜</button><button data-tool="arrow" aria-pressed="false">화살표</button><button data-tool="text" aria-pressed="false">설명</button><button data-tool="move" aria-pressed="false">이동</button><button data-tool="erase" aria-pressed="false">지우개</button><input id="drawing-color" type="color" value="#bd4335" aria-label="펜·화살표·설명 색상"></div>
      <span class="drawing-separator"></span><button id="drawing-undo" aria-label="그림 실행 취소">↶ 취소</button><button id="drawing-redo" aria-label="그림 다시 실행">↷ 다시</button>
    </div><div class="drawing-text-row" id="drawing-text-row" hidden><input id="drawing-text" maxlength="300" placeholder="설명을 입력하고 그림에서 넣을 위치를 누르세요." aria-label="그림에 넣을 설명"></div>
    <div class="drawing-viewbar"><button id="drawing-zoom-out" aria-label="작업지 축소">−</button><output id="drawing-zoom-level">100%</output><button id="drawing-zoom-in" aria-label="작업지 확대">＋</button><button id="drawing-fit">전체 보기</button><button id="drawing-actual">100%</button><button data-tool="pan" aria-pressed="false">손으로 이동</button><button id="drawing-grow">작업지 넓히기</button><span id="drawing-size"></span></div>
    <p class="drawing-source" id="drawing-source"></p><div class="drawing-workspace" id="drawing-workspace"><div id="drawing-stage"><canvas id="drawing-canvas" tabindex="0" aria-label="그림 작업 공간. 선택한 도구로 드래그하거나 클릭하세요."></canvas></div></div>
    <footer class="drawing-foot"><p id="drawing-hint"></p><button id="drawing-save" class="primary-button">노트에 넣기</button></footer><p id="drawing-status" role="status" aria-live="polite"></p></div>`;
  document.body.append(dialog);
  $('drawing-close').onclick=closeDrawing;
  dialog.addEventListener('cancel',e=>{e.preventDefault();if(drawingSession?.gesture){cancelDrawingGesture();return}if(drawingSelectionCount(drawingSession?.selection)){clearDrawingSelection();return}closeDrawing()});
  dialog.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>openDrawing(b.dataset.mode,drawingSession.section));
  dialog.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>selectDrawingTool(b.dataset.tool));
  $('drawing-element').onchange=()=>selectDrawingTool('atom');$('drawing-bond').onchange=()=>selectDrawingTool('bond');$('drawing-ring').onchange=()=>selectDrawingTool('ring');
  $('drawing-undo').onclick=()=>drawingUndo(false);$('drawing-redo').onclick=()=>drawingUndo(true);$('drawing-save').onclick=saveDrawing;
  const repeat=document.createElement('button');repeat.dataset.tool='repeat';repeat.textContent='[ ]ₙ 반복단위';repeat.setAttribute('aria-pressed','false');repeat.onclick=()=>selectDrawingTool('repeat');$('drawing-chem-tools').append(repeat);
  const lasso=document.createElement('button');lasso.dataset.tool='lasso';lasso.textContent='올가미';lasso.setAttribute('aria-pressed','false');lasso.onclick=()=>selectDrawingTool('lasso');dialog.querySelector('[data-tool=move]').before(lasso);
  const repeatRow=document.createElement('div');repeatRow.id='drawing-repeat-row';repeatRow.className='drawing-context-row';repeatRow.hidden=true;repeatRow.innerHTML='<label>반복수 <input id="drawing-repeat-count" value="n" maxlength="12" aria-label="반복수" pattern="[A-Za-z0-9]{1,12}"></label><span>반복 단위를 감싸도록 드래그하면 대괄호와 반복수가 함께 생겨요.</span>';$('drawing-text-row').after(repeatRow);
  const selectionRow=document.createElement('div');selectionRow.id='drawing-selection-row';selectionRow.className='drawing-context-row';selectionRow.hidden=true;selectionRow.innerHTML='<span id="drawing-selection-count"></span><span>선택 안쪽을 끌어 이동 · 색상으로 한꺼번에 변경</span><button id="drawing-clear-selection">선택 해제</button>';repeatRow.after(selectionRow);$('drawing-clear-selection').onclick=clearDrawingSelection;
  $('drawing-color').setAttribute('aria-label','그림 색상');$('drawing-color').title='선택한 항목의 색상 변경 · 선택이 없으면 새로 그릴 색상';$('drawing-color').onchange=changeDrawingColor;
  const colorLabel=document.createElement('label');colorLabel.className='drawing-color-label';colorLabel.textContent='색상';$('drawing-color').before(colorLabel);colorLabel.append($('drawing-color'));
  $('drawing-zoom-out').onclick=()=>setDrawingZoom(drawingSession.zoom/1.25);$('drawing-zoom-in').onclick=()=>setDrawingZoom(drawingSession.zoom*1.25);$('drawing-fit').onclick=fitDrawingView;$('drawing-actual').onclick=()=>setDrawingZoom(1);$('drawing-grow').onclick=growDrawingPaper;
  $('drawing-workspace').addEventListener('wheel',event=>{if(!event.ctrlKey&&!event.metaKey)return;event.preventDefault();if(!drawingSession?.doc)return;const r=$('drawing-workspace').getBoundingClientRect();setDrawingZoom(drawingSession.zoom*Math.exp(-event.deltaY*.002),{x:event.clientX-r.left,y:event.clientY-r.top})},{passive:false});
  new ResizeObserver(()=>{if(drawingSession?.doc&&!drawingSession.loading){layoutDrawingView();if(drawingSession.fitted)fitDrawingView()}}).observe($('drawing-workspace'));
  const canvas=$('drawing-canvas');canvas.onpointerdown=drawingPointerDown;canvas.onpointermove=drawingPointerMove;canvas.onpointerup=drawingPointerUp;canvas.onpointercancel=cancelDrawingGesture;
  canvas.onpointerleave=()=>{if(drawingSession&&!drawingSession.gesture){drawingSession.hover=null;renderDrawing()}};
  dialog.addEventListener('keydown',e=>{if(e.target.matches('input,select'))return;if((e.ctrlKey||e.metaKey)&&['z','y'].includes(e.key.toLowerCase())){e.preventDefault();drawingUndo(e.key.toLowerCase()==='y'||e.shiftKey)}});
}
function openDrawingChooser(section){
  if(!current||current.archived)return;ensureDrawingDialog();
  drawingSession={section,experimentId:current.id,dirty:false};
  $('drawing-dialog').classList.remove('drawing-expanded');$('drawing-title').textContent='그림 추가';$('drawing-choice').hidden=false;$('drawing-editor').hidden=true;$('drawing-dialog').showModal();
}
function closeDrawing(){
  if(drawingSession?.saving)return;
  if(drawingSession?.dirty&&!confirm('저장하지 않은 그림을 닫을까요?'))return;
  drawingSession=null;$('drawing-dialog').close();
}
async function openDrawing(mode,section,file=null){
  if(!current||current.archived)return;ensureDrawingDialog();
  const s={section,experimentId:current.id,dirty:false,saving:false,loading:true,undo:[],redo:[],gesture:null,background:null,edited:mode==='edit',zoom:1,fitted:false};
  $('drawing-dialog').classList.add('drawing-expanded');
  drawingSession=s;$('drawing-choice').hidden=true;$('drawing-editor').hidden=false;$('drawing-status').textContent='그림을 준비하고 있습니다…';$('drawing-save').disabled=true;
  if(!$('drawing-dialog').open)$('drawing-dialog').showModal();
  try{
    s.doc=mode==='edit'?await api(`/api/attachments/${file.id}/drawing`):{version:1,mode,width:mode==='molecule'?2400:1600,height:1000,atoms:[],bonds:[],marks:[],source_id:mode==='photo'?file.id:null,regions:mode==='photo'?(file.view_regions||[]):[]};
    if(s.doc.mode==='photo')await loadDrawingBackground(s);
    if(drawingSession!==s)return;
    $('drawing-title').textContent={molecule:'분자구조 그리기',sketch:'간단한 스케치',photo:'사진에 화살표·설명'}[s.doc.mode];
    $('drawing-chem-tools').hidden=s.doc.mode!=='molecule';$('drawing-pen').hidden=s.doc.mode==='molecule';
    $('drawing-source').textContent=s.doc.mode==='photo'?'원본은 그대로 두고, 주석이 있는 사본을 저장합니다. 선택한 사진 영역만 표시합니다.':s.doc.mode==='molecule'?'기본 구조식 편집기 · 탄소와 탄소에 결합한 수소는 생략됩니다. 화학적 타당성·입체구조 자동 검증은 지원하지 않습니다.':'이 컴퓨터에서 직접 그린 그림입니다.';
    $('drawing-save').textContent=s.edited||s.doc.mode==='photo'?'사본으로 노트에 넣기':'노트에 넣기';
    $('drawing-color').value=s.doc.mode==='molecule'?'#23392e':'#bd4335';$('drawing-repeat-count').value='n';
    sizeDrawingCanvas();s.loading=false;$('drawing-status').textContent='';selectDrawingTool(s.doc.mode==='molecule'?'bond':s.doc.mode==='photo'?'arrow':'pen');layoutDrawingView();
    $('drawing-workspace').scrollTo(0,0);if(s.doc.mode==='photo')fitDrawingView();renderDrawing();
  }catch(error){if(drawingSession===s){s.loading=true;$('drawing-status').textContent=error.message}}
}
function sizeDrawingCanvas(){
  const s=drawingSession,c=$('drawing-canvas');s.pixelRatio=Math.min(2,4096/Math.max(s.doc.width,s.doc.height));
  const width=Math.round(s.doc.width*s.pixelRatio),height=Math.round(s.doc.height*s.pixelRatio);if(c.width!==width)c.width=width;if(c.height!==height)c.height=height;
}
function minimumDrawingZoom(){const s=drawingSession,v=$('drawing-workspace');return Math.max(.005,Math.min(.1,(v.clientWidth-32)/s.doc.width,(v.clientHeight-32)/s.doc.height))}
function layoutDrawingView(){
  const s=drawingSession;if(!s?.doc)return;const viewport=$('drawing-workspace'),stage=$('drawing-stage'),canvas=$('drawing-canvas'),w=s.doc.width*s.zoom,h=s.doc.height*s.zoom;
  Object.assign(stage.style,{width:`${Math.max(viewport.clientWidth,w+32)}px`,height:`${Math.max(viewport.clientHeight,h+32)}px`});
  Object.assign(canvas.style,{width:`${w}px`,height:`${h}px`,left:`${Math.max(16,(viewport.clientWidth-w)/2)}px`,top:`${Math.max(16,(viewport.clientHeight-h)/2)}px`});
  $('drawing-zoom-level').textContent=`${Math.round(s.zoom*100)}%`;$('drawing-size').textContent=`${s.doc.width} × ${s.doc.height}`;
  $('drawing-zoom-out').disabled=s.zoom<=minimumDrawingZoom();$('drawing-zoom-in').disabled=s.zoom>=3;$('drawing-grow').disabled=s.doc.mode==='photo'||s.doc.width>=4096&&s.doc.height>=4096;
}
function setDrawingZoom(value,anchor=null){
  const s=drawingSession;if(!s?.doc||s.loading||s.gesture)return;const viewport=$('drawing-workspace'),canvas=$('drawing-canvas'),p=anchor||{x:viewport.clientWidth/2,y:viewport.clientHeight/2};
  const x=(viewport.scrollLeft+p.x-canvas.offsetLeft)/s.zoom,y=(viewport.scrollTop+p.y-canvas.offsetTop)/s.zoom;
  s.zoom=Math.max(minimumDrawingZoom(),Math.min(3,value));s.fitted=false;s.hover=null;layoutDrawingView();viewport.scrollLeft=x*s.zoom+canvas.offsetLeft-p.x;viewport.scrollTop=y*s.zoom+canvas.offsetTop-p.y;renderDrawing();
}
function fitDrawingView(){const s=drawingSession;if(!s?.doc||s.gesture)return;const view=$('drawing-workspace');setDrawingZoom(Math.min((view.clientWidth-32)/s.doc.width,(view.clientHeight-32)/s.doc.height));s.fitted=true;view.scrollTo(0,0)}
function growDrawingPaper(){const s=drawingSession;if(!s?.doc||s.loading||s.saving||s.gesture||s.doc.mode==='photo')return;const before=drawingClone(s.doc);s.doc.width=Math.min(4096,s.doc.width+800);s.doc.height=Math.min(4096,s.doc.height+400);drawingRemember(before);sizeDrawingCanvas();layoutDrawingView();renderDrawing();$('drawing-status').textContent='오른쪽과 아래쪽에 빈 작업지를 추가했습니다. 스크롤하거나 손으로 이동하세요.'}
async function loadDrawingBackground(s){
  const response=await fetch(`/api/attachments/${s.doc.source_id}`,{headers:{'X-Labnote-Token':token}});if(!response.ok)throw new Error('원본 사진을 불러올 수 없습니다.');
  const url=URL.createObjectURL(await response.blob());
  try{
    const img=new Image();img.src=url;await img.decode();
    const bg=document.createElement('canvas'),regions=s.doc.regions||[];
    const w=regions.length?regions.reduce((n,r)=>n+r.width,0)+24*(regions.length-1):img.naturalWidth;
    const h=regions.length?Math.max(...regions.map(r=>r.height))+40:img.naturalHeight;
    const scale=Math.min(1,4096/w,4096/h);bg.width=Math.round(w*scale);bg.height=Math.round(h*scale);
    const ctx=bg.getContext('2d');ctx.scale(scale,scale);ctx.fillStyle='#ffffff';ctx.fillRect(0,0,w,h);
    if(regions.length){let x=0;ctx.font='24px sans-serif';ctx.fillStyle='#253c31';for(const r of regions){ctx.fillText(r.label||'',x,28);ctx.drawImage(img,r.x,r.y,r.width,r.height,x,40,r.width,r.height);x+=r.width+24}}
    else ctx.drawImage(img,0,0);
    s.background=bg;
    if(!s.edited){s.doc.width=1200;s.doc.height=Math.max(100,Math.min(3000,Math.round(h/w*1200)))}
  }finally{URL.revokeObjectURL(url)}
}
function selectDrawingTool(tool){
  const s=drawingSession;if(!s?.doc||s.loading||s.saving)return;if(s.gesture)cancelDrawingGesture();s.tool=tool;s.hover=null;if(!['lasso','move','pan'].includes(tool))s.selection=null;
  document.querySelectorAll('#drawing-dialog [data-tool]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.tool===tool)));
  $('drawing-text-row').hidden=tool!=='text';
  $('drawing-repeat-row').hidden=tool!=='repeat';
  $('drawing-hint').textContent={bond:'빈 곳이나 원자에서 드래그해 결합을 만드세요. 기존 결합을 누르면 선택한 결합 종류로 바뀝니다.',atom:'빈 곳을 누르면 원자가 생겨요. 기존 원자를 누르면 선택한 원자로 바뀝니다.',ring:'결합 끝에 마우스를 대면 붙을 고리가 보여요. 클릭하면 연결되고, 드래그하면 방향을 정할 수 있어요. 빈 곳에는 새 고리가 생깁니다.',pen:'마우스나 손가락으로 그리세요. 저장한 그림은 기본적으로 🔒 AI 사용 금지입니다.',arrow:'강조할 방향으로 드래그하세요. 사진 원본에는 영향을 주지 않습니다.',text:'위에 설명을 입력한 뒤, 그림에서 넣을 위치를 누르세요.',move:'원자나 설명·화살표·선을 잡고 옮기세요.',pan:'작업지를 잡고 끌어 이동하세요. 그림 자체는 바뀌지 않습니다. Ctrl + 휠로 확대·축소할 수 있어요.',erase:'원자·결합·그린 선·설명을 눌러 지우세요. 원본 사진은 지워지지 않습니다.'}[tool];
  $('drawing-canvas').style.cursor=tool==='pan'?'grab':'crosshair';
  if(tool==='repeat')$('drawing-hint').textContent='반복 단위의 왼쪽 위에서 오른쪽 아래로 드래그하세요. 대괄호와 n이 함께 생깁니다.';
  if(tool==='lasso')$('drawing-hint').textContent='옮길 부분을 자유롭게 둘러싸세요. 선택 안쪽을 끌면 함께 이동하고, 색상을 바꾸면 선택한 부분에 적용돼요. 한 항목은 클릭으로 선택할 수 있어요.';
  renderDrawing();
  if(tool==='text')$('drawing-text').focus();
}
function drawingPoint(e){const c=$('drawing-canvas'),r=c.getBoundingClientRect(),d=drawingSession.doc;return{x:Math.max(0,Math.min(d.width,(e.clientX-r.left)/r.width*d.width)),y:Math.max(0,Math.min(d.height,(e.clientY-r.top)/r.height*d.height))}}
function drawingDistance(a,b){return Math.hypot(a.x-b.x,a.y-b.y)}
function nearestDrawingAtom(doc,p,radius=26){let index=-1,distance=radius;doc.atoms.forEach((a,i)=>{const next=drawingDistance(a,p);if(next<distance){index=i;distance=next}});return index}
function drawingAtomAt(p){return nearestDrawingAtom(drawingSession.doc,p)}
// Placement is shared by the ghost and the committed graph: the anchor is
// reused, so a connected ring never hides a duplicate atom at its first vertex.
function drawingRingPlacement(doc,p,value,end=null){
  const n=value==='5'?5:6,radius=64/(2*Math.sin(Math.PI/n)),anchor=nearestDrawingAtom(doc,p);
  const make=(center,angle)=>Array.from({length:n},(_,i)=>({x:center.x+radius*Math.cos(angle+i*2*Math.PI/n),y:center.y+radius*Math.sin(angle+i*2*Math.PI/n)}));
  const assess=points=>{
    let score=0,valid=points.every(a=>a.x>=8&&a.x<=doc.width-8&&a.y>=8&&a.y<=doc.height-8);
    points.forEach((a,i)=>{if(anchor>=0&&i===0)return;doc.atoms.forEach((old,j)=>{if(j===anchor)return;const gap=drawingDistance(a,old);if(gap<28)valid=false;score+=Math.max(0,80-gap)**2});
      doc.bonds.forEach(b=>{const gap=drawingLineDistance(a,doc.atoms[b.a],doc.atoms[b.b]);if(gap<14)valid=false;score+=Math.max(0,36-gap)**2});});
    // Existing atoms must not land on a new edge, either.
    doc.atoms.forEach((a,j)=>{if(j===anchor)return;const sides=points.map((b,i)=>{const c=points[(i+1)%n];if(drawingLineDistance(a,b,c)<14)valid=false;return(c.x-b.x)*(a.y-b.y)-(c.y-b.y)*(a.x-b.x)});if(sides.every(v=>v>=0)||sides.every(v=>v<=0))valid=false});
    return {points,anchor,valid,score};
  };
  if(anchor<0){const center={x:Math.max(radius+8,Math.min(doc.width-radius-8,p.x)),y:Math.max(radius+8,Math.min(doc.height-radius-8,p.y))};return assess(make(center,-Math.PI/2))}
  const root=doc.atoms[anchor],neighbors=doc.bonds.filter(b=>b.a===anchor||b.b===anchor).map(b=>doc.atoms[b.a===anchor?b.b:b.a]);
  let dx=0,dy=0;neighbors.forEach(a=>{const length=drawingDistance(root,a)||1;dx+=(root.x-a.x)/length;dy+=(root.y-a.y)/length});
  const dragging=end&&drawingDistance(p,end)>12;
  const preferred=dragging?Math.round(Math.atan2(end.y-root.y,end.x-root.x)/(Math.PI/6))*Math.PI/6:Math.hypot(dx,dy)>.01?Math.atan2(dy,dx):0;
  const offsets=dragging?[0]:[0,1,-1,2,-2,3,-3,4,-4,5,-5,6];
  const choices=offsets.map(offset=>{const angle=preferred+offset*Math.PI/6,center={x:root.x+radius*Math.cos(angle),y:root.y+radius*Math.sin(angle)},points=make(center,angle+Math.PI);points[0]={x:root.x,y:root.y};const plan=assess(points);plan.score+=Math.abs(offset)*20;return plan});
  choices.sort((a,b)=>Number(b.valid)-Number(a.valid)||a.score-b.score);return choices[0];
}
function addDrawingRing(doc,placement,value,color='#23392e'){
  if(!placement.valid)return false;
  const ids=placement.points.map((p,i)=>{if(i===0&&placement.anchor>=0)return placement.anchor;doc.atoms.push({...p,label:'C',color});return doc.atoms.length-1});
  ids.forEach((a,i)=>doc.bonds.push({a,b:ids[(i+1)%ids.length],order:value==='benzene'&&i%2===0?2:1,color}));return true;
}
function drawingLineDistance(p,a,b){const l=(b.x-a.x)**2+(b.y-a.y)**2,t=l?Math.max(0,Math.min(1,((p.x-a.x)*(b.x-a.x)+(p.y-a.y)*(b.y-a.y))/l)):0;return drawingDistance(p,{x:a.x+t*(b.x-a.x),y:a.y+t*(b.y-a.y)})}
function drawingHit(p){
  const d=drawingSession.doc;
  for(let i=d.marks.length-1;i>=0;i--){const m=d.marks[i];if(m.kind==='text'){const ctx=$('drawing-canvas').getContext('2d');ctx.font='26px sans-serif';if(p.x>=m.points[0].x-8&&p.x<=m.points[0].x+ctx.measureText(m.text).width+8&&Math.abs(p.y-m.points[0].y)<30)return{kind:'mark',i}}
    else if(m.kind==='repeat'){if(drawingRepeatHit(m,p))return{kind:'mark',i}}
    else if(m.points.some((a,j)=>drawingLineDistance(p,a,m.points[Math.max(0,j-1)])<14))return{kind:'mark',i};}
  const i=drawingAtomAt(p);if(i>=0)return{kind:'atom',i};
  const j=d.bonds.findIndex(b=>drawingLineDistance(p,d.atoms[b.a],d.atoms[b.b])<12);return j>=0?{kind:'bond',i:j}:null;
}
function drawingRemember(before){const s=drawingSession;if(JSON.stringify(before)===JSON.stringify(s.doc))return;s.undo.push(before);if(s.undo.length>50)s.undo.shift();s.redo=[];s.dirty=true}
function drawingUndo(redo){const s=drawingSession;if(!s?.doc||s.loading||s.saving||s.gesture)return;const from=redo?s.redo:s.undo,to=redo?s.undo:s.redo;if(!from.length)return;to.push(drawingClone(s.doc));s.doc=from.pop();s.hover=null;s.selection=null;s.dirty=true;sizeDrawingCanvas();layoutDrawingView();renderDrawing()}
function drawingPointerDown(e){
  const s=drawingSession;if(!s?.doc||s.loading||s.saving||s.gesture||e.button!==0)return;e.preventDefault();const c=$('drawing-canvas');c.focus({preventScroll:true});c.setPointerCapture(e.pointerId);
  if(s.tool==='pan'){s.gesture={id:e.pointerId,pan:true,x:e.clientX,y:e.clientY,left:$('drawing-workspace').scrollLeft,top:$('drawing-workspace').scrollTop};c.style.cursor='grabbing';return}
  const p=drawingPoint(e),d=s.doc,before=drawingClone(d),hit=drawingHit(p),color=$('drawing-color').value;
  s.gesture={id:e.pointerId,start:p,end:p,before,hit};s.hover=null;$('drawing-status').textContent='';
  if(['lasso','move'].includes(s.tool)&&drawingSelectionCount(s.selection)&&drawingPointInBounds(p,drawingSelectionBounds(d,s.selection))){s.gesture.selectionMove=true;s.gesture.selection=drawingClone(s.selection);c.style.cursor='grabbing';return}
  if(s.tool==='lasso'){s.selection=null;s.gesture.lasso=[p];renderDrawing();return}
  if(s.tool==='repeat'){const text=$('drawing-repeat-count').value.trim();if(!/^[A-Za-z0-9]{1,12}$/.test(text)){$('drawing-status').textContent='반복수는 n, m, 10처럼 영문·숫자 1~12자로 입력해 주세요.';s.gesture.invalid=true;return}d.marks.push({kind:'repeat',color,points:[p,p],text});s.gesture.mark=d.marks.at(-1)}
  if(s.tool==='pen'||s.tool==='arrow'){d.marks.push({kind:s.tool,color,points:[p],text:''});s.gesture.mark=d.marks.at(-1)}
  if(s.tool==='text'){const text=$('drawing-text').value.trim();if(text)d.marks.push({kind:'text',color,points:[p],text});else $('drawing-status').textContent='설명을 먼저 입력해 주세요.'}
  if(s.tool==='atom'){const i=drawingAtomAt(p),label=$('drawing-element').value;if(i>=0)Object.assign(d.atoms[i],{label,color});else d.atoms.push({...p,label,color})}
  if(s.tool==='erase'&&hit){if(hit.kind==='mark')d.marks.splice(hit.i,1);if(hit.kind==='bond')d.bonds.splice(hit.i,1);if(hit.kind==='atom'){d.atoms.splice(hit.i,1);d.bonds=d.bonds.filter(b=>b.a!==hit.i&&b.b!==hit.i).map(b=>({...b,a:b.a>hit.i?b.a-1:b.a,b:b.b>hit.i?b.b-1:b.b}))}}
  renderDrawing();
}
function drawingPointerMove(e){
  const s=drawingSession;if(!s?.doc||s.loading||s.saving)return;const g=s.gesture,p=drawingPoint(e);
  if(g?.pan&&g.id===e.pointerId){$('drawing-workspace').scrollLeft=g.left+g.x-e.clientX;$('drawing-workspace').scrollTop=g.top+g.y-e.clientY;return}
  if(!g){if(['lasso','move'].includes(s.tool))$('drawing-canvas').style.cursor=drawingSelectionCount(s.selection)&&drawingPointInBounds(p,drawingSelectionBounds(s.doc,s.selection))?'grab':'crosshair';if(s.tool==='ring'||s.tool==='bond'){s.hover=p;renderDrawing()}return}if(g.id!==e.pointerId)return;g.end=p;
  if(g.invalid)return;
  if(g.selectionMove){translateDrawingSelection(s.doc,g.before,g.selection,p.x-g.start.x,p.y-g.start.y);renderDrawing();return}
  if(g.lasso){if(g.lasso.length<2000&&drawingDistance(p,g.lasso.at(-1))>2/Math.max(.1,s.zoom))g.lasso.push(p);renderDrawing();return}
  if(s.tool==='repeat')g.mark.points=constrainDrawingRepeat(g.start,p,g.mark.text,s.doc);
  if(s.tool==='pen'&&g.mark.points.length<10000&&drawingDistance(p,g.mark.points.at(-1))>1)g.mark.points.push(p);
  if(s.tool==='arrow')g.mark.points=[g.start,p];
  if(s.tool==='move'&&g.hit){const dx=p.x-g.start.x,dy=p.y-g.start.y;if(g.hit.kind==='atom'){const a=g.before.atoms[g.hit.i];Object.assign(s.doc.atoms[g.hit.i],{x:Math.max(0,Math.min(s.doc.width,a.x+dx)),y:Math.max(0,Math.min(s.doc.height,a.y+dy))})}if(g.hit.kind==='mark'){s.doc.marks[g.hit.i].points=g.before.marks[g.hit.i].points.map(a=>({x:Math.max(0,Math.min(s.doc.width,a.x+dx)),y:Math.max(0,Math.min(s.doc.height,a.y+dy))}))}}
  renderDrawing();
}
function drawingBondEnd(start,end){const angle=Math.round(Math.atan2(end.y-start.y,end.x-start.x)/(Math.PI/6))*Math.PI/6;return{x:start.x+64*Math.cos(angle),y:start.y+64*Math.sin(angle)}}
function drawingPointerUp(e){
  const s=drawingSession,g=s?.gesture;if(!g||g.id!==e.pointerId)return;
  if(g.pan){s.gesture=null;$('drawing-canvas').releasePointerCapture(e.pointerId);$('drawing-canvas').style.cursor='grab';return}
  g.end=drawingPoint(e);const d=s.doc;
  if(g.selectionMove){translateDrawingSelection(d,g.before,g.selection,g.end.x-g.start.x,g.end.y-g.start.y)}
  else if(g.lasso){
    g.lasso.push(g.end);s.selection=drawingLassoSelection(d,g.lasso);
    if(drawingDistance(g.start,g.end)<8&&g.lasso.length<=3)s.selection=drawingSelectionFromHit(g.hit);
    if(!drawingSelectionCount(s.selection))$('drawing-status').textContent='선택된 항목이 없어요. 옮길 원자·그림을 모두 감싸 주세요.';
  }
  if(s.tool==='repeat'&&!g.invalid){g.mark.points=constrainDrawingRepeat(g.start,g.end,g.mark.text,d);const [a,b]=g.mark.points;if(b.x-a.x<24||b.y-a.y<30){d.marks.pop();$('drawing-status').textContent='반복 단위를 감쌀 만큼 넓게 드래그해 주세요.'}}
  if(s.tool==='ring'){
    const value=$('drawing-ring').value,placement=drawingRingPlacement(d,g.start,value,g.end);
    if(!addDrawingRing(d,placement,value,$('drawing-color').value))$('drawing-status').textContent='다른 원자나 화면 가장자리와 겹쳐요. 빈 방향으로 드래그해 주세요.';
  }
  if(s.tool==='bond'){
    const color=$('drawing-color').value;
    if(drawingDistance(g.start,g.end)<8&&g.hit?.kind==='bond')Object.assign(d.bonds[g.hit.i],{order:Number($('drawing-bond').value),color});
    else if(drawingDistance(g.start,g.end)>=8){let a=drawingAtomAt(g.start);if(a<0){a=d.atoms.length;d.atoms.push({...g.start,label:'C',color})}let b=drawingAtomAt(g.end);if(b<0){const end=drawingBondEnd(d.atoms[a],g.end);if(end.x>=0&&end.x<=d.width&&end.y>=0&&end.y<=d.height){b=drawingAtomAt(end);if(b<0){b=d.atoms.length;d.atoms.push({...end,label:'C',color})}}}if(b>=0&&a!==b){const bond=d.bonds.find(v=>v.a===a&&v.b===b||v.a===b&&v.b===a);if(bond)Object.assign(bond,{order:Number($('drawing-bond').value),color});else d.bonds.push({a,b,order:Number($('drawing-bond').value),color})}}
  }
  if(s.tool==='arrow'&&drawingDistance(g.start,g.end)<5)d.marks.pop();
  if($('drawing-canvas').hasPointerCapture(e.pointerId))$('drawing-canvas').releasePointerCapture(e.pointerId);
  s.gesture=null;s.hover=null;$('drawing-canvas').style.cursor=drawingSelectionCount(s.selection)?'grab':'crosshair';drawingRemember(g.before);renderDrawing();
}
function cancelDrawingGesture(){const s=drawingSession;if(s?.gesture){if(!s.gesture.pan)s.doc=s.gesture.before;s.gesture=null;$('drawing-canvas').style.cursor=s.tool==='pan'?'grab':'crosshair';renderDrawing()}}
function paintDrawing(ctx,d,background){
  ctx.fillStyle='#ffffff';ctx.fillRect(0,0,d.width,d.height);if(background){const scale=Math.min(d.width/background.width,d.height/background.height),w=background.width*scale,h=background.height*scale;ctx.drawImage(background,(d.width-w)/2,(d.height-h)/2,w,h)}
  ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle='#23392e';ctx.lineWidth=2.6;
  for(const b of d.bonds){ctx.strokeStyle=b.color||'#23392e';const a=d.atoms[b.a],z=d.atoms[b.b],length=drawingDistance(a,z)||1,nx=-(z.y-a.y)/length,ny=(z.x-a.x)/length;const offsets=b.order===3?[-6,0,6]:b.order===2?[-3.5,3.5]:[0];for(const offset of offsets){ctx.beginPath();ctx.moveTo(a.x+nx*offset,a.y+ny*offset);ctx.lineTo(z.x+nx*offset,z.y+ny*offset);ctx.stroke()}}
  ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='25px sans-serif';
  d.atoms.forEach((a,i)=>{if(a.label==='C'&&d.bonds.some(b=>b.a===i||b.b===i))return;const w=ctx.measureText(a.label).width;ctx.fillStyle='#ffffff';ctx.fillRect(a.x-w/2-3,a.y-15,w+6,30);ctx.fillStyle=a.color||{O:'#b43d36',N:'#355bae',S:'#946818'}[a.label]||'#23392e';ctx.fillText(a.label,a.x,a.y)});
  ctx.textAlign='left';ctx.textBaseline='alphabetic';ctx.font='26px sans-serif';
  for(const m of d.marks){ctx.strokeStyle=m.color;ctx.fillStyle=m.color;ctx.lineWidth=3;const p=m.points[0];if(m.kind==='repeat'){paintDrawingRepeat(ctx,m);continue}if(m.kind==='text'){ctx.save();ctx.strokeStyle='white';ctx.lineWidth=5;ctx.strokeText(m.text,p.x,p.y);ctx.fillText(m.text,p.x,p.y);ctx.restore();continue}ctx.beginPath();ctx.moveTo(p.x,p.y);for(const v of m.points)ctx.lineTo(v.x,v.y);ctx.stroke();if(m.points.length===1){ctx.beginPath();ctx.arc(p.x,p.y,1.5,0,Math.PI*2);ctx.fill()}if(m.kind==='arrow'&&m.points.length>1){const z=m.points.at(-1),angle=Math.atan2(z.y-p.y,z.x-p.x);ctx.beginPath();ctx.moveTo(z.x,z.y);ctx.lineTo(z.x-17*Math.cos(angle-.45),z.y-17*Math.sin(angle-.45));ctx.lineTo(z.x-17*Math.cos(angle+.45),z.y-17*Math.sin(angle+.45));ctx.closePath();ctx.fill()}}
}
function renderDrawing(){
  const s=drawingSession;if(!s?.doc)return;const ctx=$('drawing-canvas').getContext('2d');ctx.setTransform(s.pixelRatio||2,0,0,s.pixelRatio||2,0,0);paintDrawing(ctx,s.doc,s.background);
  if(s.gesture&&s.tool==='bond'){const g=s.gesture,a=drawingAtomAt(g.start),start=a>=0?s.doc.atoms[a]:g.start,b=drawingAtomAt(g.end),end=b>=0?s.doc.atoms[b]:drawingBondEnd(start,g.end);ctx.strokeStyle='#72947c';ctx.setLineDash([5,5]);ctx.beginPath();ctx.moveTo(start.x,start.y);ctx.lineTo(end.x,end.y);ctx.stroke();ctx.setLineDash([])}
  if(!s.saving&&!s.loading&&(s.hover||s.gesture)&&s.tool==='ring'){
    const plan=drawingRingPlacement(s.doc,s.gesture?.start||s.hover,$('drawing-ring').value,s.gesture?.end),color=plan.valid?'#4a9770':'#bb574a';
    ctx.save();ctx.strokeStyle=color;ctx.lineWidth=2.5;ctx.setLineDash([7,5]);
    plan.points.forEach((a,i)=>{const b=plan.points[(i+1)%plan.points.length];ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();if($('drawing-ring').value==='benzene'&&i%2===0){const center=plan.points.reduce((sum,p)=>({x:sum.x+p.x/plan.points.length,y:sum.y+p.y/plan.points.length}),{x:0,y:0});ctx.beginPath();ctx.moveTo(a.x+(center.x-a.x)*.13,a.y+(center.y-a.y)*.13);ctx.lineTo(b.x+(center.x-b.x)*.13,b.y+(center.y-b.y)*.13);ctx.stroke()}});
    if(plan.anchor>=0){ctx.setLineDash([]);ctx.beginPath();ctx.arc(s.doc.atoms[plan.anchor].x,s.doc.atoms[plan.anchor].y,12,0,Math.PI*2);ctx.stroke()}ctx.restore();
  }else if(!s.saving&&s.hover&&s.tool==='bond'){const i=drawingAtomAt(s.hover);if(i>=0){ctx.save();ctx.strokeStyle='#4a9770';ctx.lineWidth=2;ctx.beginPath();ctx.arc(s.doc.atoms[i].x,s.doc.atoms[i].y,12,0,Math.PI*2);ctx.stroke();ctx.restore()}}
  if(!s.saving)paintDrawingSelection(ctx,s);
  const selectionCount=drawingSelectionCount(s.selection);$('drawing-selection-row').hidden=!selectionCount;
  $('drawing-selection-count').textContent=selectionCount?`원자 ${s.selection.atoms.length} · 결합 ${s.selection.bonds.length} · 표시 ${s.selection.marks.length} 선택`:'';
  $('drawing-undo').disabled=!s.undo.length||s.saving;$('drawing-redo').disabled=!s.redo.length||s.saving;$('drawing-save').disabled=s.loading||s.saving||Boolean(s.gesture)||(!s.doc.atoms.length&&!s.doc.marks.length);
}
async function saveDrawing(){
  const s=drawingSession;if(!s?.doc||s.saving||s.loading||s.gesture)return;s.saving=true;renderDrawing();$('drawing-status').textContent='이 컴퓨터에 저장 중…';
  try{
    await persistRecordEdits();if(current?.id!==s.experimentId)throw new Error('열린 실험이 바뀌었습니다. 그림을 다시 열어 주세요.');
    const prefix={molecule:'분자구조',sketch:'스케치',photo:'사진 주석 사본'}[s.doc.mode];
    const result=await api(`/api/experiments/${s.experimentId}/drawings`,'POST',{section_key:s.section,name:`${prefix} ${new Date().toLocaleTimeString('ko-KR',{hour12:false}).replaceAll(':','-')}.png`,data:exportDrawingImage(s),document:s.doc});
    if(current?.id===s.experimentId){current=result;renderSections();turnToSection(s.section)}
    s.dirty=false;drawingSession=null;$('drawing-dialog').close();toast('그림을 저장했습니다. 🔒 AI 사용 금지로 보관됩니다.');
  }catch(error){s.saving=false;$('drawing-status').textContent=error.message;renderDrawing()}
}
function exportDrawingImage(s){
  const canvas=$('drawing-canvas');if(s.doc.mode==='photo')return canvas.toDataURL('image/png').split(',')[1];
  const ctx=canvas.getContext('2d'),points=[...s.doc.atoms];ctx.font='26px sans-serif';
  for(const mark of s.doc.marks){points.push(...drawingMarkExtent(mark));}
  const bounds=points.reduce((b,p)=>({left:Math.min(b.left,p.x),top:Math.min(b.top,p.y),right:Math.max(b.right,p.x),bottom:Math.max(b.bottom,p.y)}),{left:Infinity,top:Infinity,right:0,bottom:0});
  const x=Math.max(0,bounds.left-40),y=Math.max(0,bounds.top-40),right=Math.min(s.doc.width,bounds.right+40),bottom=Math.min(s.doc.height,bounds.bottom+40);
  const out=document.createElement('canvas');out.width=Math.ceil((right-x)*s.pixelRatio);out.height=Math.ceil((bottom-y)*s.pixelRatio);out.getContext('2d').drawImage(canvas,x*s.pixelRatio,y*s.pixelRatio,out.width,out.height,0,0,out.width,out.height);return out.toDataURL('image/png').split(',')[1];
}

function drawingRepeatPoints(a,b){return[{x:Math.min(a.x,b.x),y:Math.min(a.y,b.y)},{x:Math.max(a.x,b.x),y:Math.max(a.y,b.y)}]}
function constrainDrawingRepeat(a,b,text,doc){const maxX=Math.max(0,doc.width-12-drawingTextWidth(text,'italic 24px serif')),maxY=doc.height-18;return drawingRepeatPoints(a,b).map(p=>({x:Math.min(maxX,p.x),y:Math.min(maxY,p.y)}))}
function drawingTextWidth(text,font='26px sans-serif'){
  if(typeof document==='undefined')return text.length*16;
  const ctx=$('drawing-canvas').getContext('2d');ctx.save();ctx.font=font;const width=ctx.measureText(text).width;ctx.restore();return width;
}
function drawingMarkExtent(mark){
  if(mark.kind==='repeat'){const [a,b]=mark.points,right=b.x+8+drawingTextWidth(mark.text,'italic 24px serif'),bottom=b.y+18;return[a,{x:right,y:a.y},{x:right,y:bottom},{x:a.x,y:bottom}]}
  if(mark.kind==='text'){const p=mark.points[0];return[{x:p.x,y:p.y-28},{x:p.x+drawingTextWidth(mark.text),y:p.y+4}]}
  return mark.points;
}
function drawingBounds(points){return points.reduce((b,p)=>({left:Math.min(b.left,p.x),top:Math.min(b.top,p.y),right:Math.max(b.right,p.x),bottom:Math.max(b.bottom,p.y)}),{left:Infinity,top:Infinity,right:-Infinity,bottom:-Infinity})}
function drawingPointInBounds(p,b,padding=10){return b&&p.x>=b.left-padding&&p.x<=b.right+padding&&p.y>=b.top-padding&&p.y<=b.bottom+padding}
function paintDrawingRepeat(ctx,mark){
  const [a,b]=mark.points;if(b.x-a.x<2||b.y-a.y<2)return;const cap=Math.min(16,(b.x-a.x)/4);
  ctx.save();ctx.strokeStyle=mark.color;ctx.fillStyle=mark.color;ctx.lineWidth=3;ctx.lineCap='square';ctx.lineJoin='miter';
  ctx.beginPath();ctx.moveTo(a.x+cap,a.y);ctx.lineTo(a.x,a.y);ctx.lineTo(a.x,b.y);ctx.lineTo(a.x+cap,b.y);
  ctx.moveTo(b.x-cap,a.y);ctx.lineTo(b.x,a.y);ctx.lineTo(b.x,b.y);ctx.lineTo(b.x-cap,b.y);ctx.stroke();
  ctx.font='italic 24px serif';ctx.textAlign='left';ctx.textBaseline='alphabetic';ctx.fillText(mark.text,b.x+8,b.y+14);ctx.restore();
}
function drawingRepeatHit(mark,p){
  const [a,b]=mark.points,cap=Math.min(16,(b.x-a.x)/4),edges=[[{x:a.x+cap,y:a.y},a],[a,{x:a.x,y:b.y}],[{x:a.x,y:b.y},{x:a.x+cap,y:b.y}],[{x:b.x-cap,y:a.y},{x:b.x,y:a.y}],[{x:b.x,y:a.y},b],[b,{x:b.x-cap,y:b.y}]];
  return edges.some(([start,end])=>drawingLineDistance(p,start,end)<12)||drawingPointInBounds(p,{left:b.x+8,top:b.y-10,right:b.x+8+drawingTextWidth(mark.text,'italic 24px serif'),bottom:b.y+18},4);
}
function drawingPointInPolygon(p,polygon){
  if(polygon.length<3)return false;let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const a=polygon[i],b=polygon[j];if(drawingLineDistance(p,a,b)<.5)return true;
    if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)inside=!inside;
  }return inside;
}
function drawingSelectionCount(selection){return selection?selection.atoms.length+selection.bonds.length+selection.marks.length:0}
function drawingLassoSelection(doc,polygon){
  const selected={atoms:[],bonds:[],marks:[]};
  doc.atoms.forEach((a,i)=>{if(drawingPointInPolygon(a,polygon))selected.atoms.push(i)});
  const atoms=new Set(selected.atoms);doc.bonds.forEach((b,i)=>{if(atoms.has(b.a)&&atoms.has(b.b))selected.bonds.push(i)});
  doc.marks.forEach((m,i)=>{if(drawingMarkExtent(m).every(p=>drawingPointInPolygon(p,polygon)))selected.marks.push(i)});return selected;
}
function drawingSelectionFromHit(hit){const s={atoms:[],bonds:[],marks:[]};if(hit)s[{atom:'atoms',bond:'bonds',mark:'marks'}[hit.kind]].push(hit.i);return s}
function drawingMovingAtoms(doc,selection){const ids=new Set(selection.atoms);selection.bonds.forEach(i=>{ids.add(doc.bonds[i].a);ids.add(doc.bonds[i].b)});return [...ids]}
function drawingSelectionBounds(doc,selection){
  if(!drawingSelectionCount(selection))return null;const points=drawingMovingAtoms(doc,selection).map(i=>doc.atoms[i]);selection.marks.forEach(i=>points.push(...drawingMarkExtent(doc.marks[i])));return drawingBounds(points);
}
function translateDrawingSelection(doc,before,selection,dx,dy){
  const bounds=drawingSelectionBounds(before,selection);if(!bounds)return;
  // Clamp the translation once for the entire group, preserving all distances.
  dx=Math.max(-bounds.left,Math.min(before.width-bounds.right,dx));dy=Math.max(-bounds.top,Math.min(before.height-bounds.bottom,dy));
  drawingMovingAtoms(before,selection).forEach(i=>{doc.atoms[i].x=before.atoms[i].x+dx;doc.atoms[i].y=before.atoms[i].y+dy});
  selection.marks.forEach(i=>doc.marks[i].points=before.marks[i].points.map(p=>({x:p.x+dx,y:p.y+dy})));
}
function recolorDrawingSelection(doc,selection,color){
  selection.atoms.forEach(i=>doc.atoms[i].color=color);selection.bonds.forEach(i=>doc.bonds[i].color=color);selection.marks.forEach(i=>doc.marks[i].color=color);
}
function changeDrawingColor(){const s=drawingSession;if(!s?.doc||s.loading||s.saving||s.gesture)return;if(drawingSelectionCount(s.selection)){const before=drawingClone(s.doc);recolorDrawingSelection(s.doc,s.selection,$('drawing-color').value);drawingRemember(before);renderDrawing()}}
function clearDrawingSelection(){if(!drawingSession||drawingSession.saving)return;drawingSession.selection=null;renderDrawing()}
function paintDrawingSelection(ctx,s){
  const scale=Math.max(.1,s.zoom||1);ctx.save();ctx.lineWidth=1.5/scale;ctx.strokeStyle='#2581ba';ctx.fillStyle='#2581ba20';ctx.setLineDash([6/scale,4/scale]);
  if(s.gesture?.lasso){const points=s.gesture.lasso;ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);points.forEach(p=>ctx.lineTo(p.x,p.y));ctx.closePath();ctx.fill();ctx.stroke()}
  if(drawingSelectionCount(s.selection)){
    const bounds=drawingSelectionBounds(s.doc,s.selection);ctx.strokeRect(bounds.left-8,bounds.top-8,bounds.right-bounds.left+16,bounds.bottom-bounds.top+16);
    ctx.setLineDash([]);ctx.strokeStyle='#2581ba99';ctx.lineWidth=6/scale;
    s.selection.bonds.forEach(i=>{const b=s.doc.bonds[i],a=s.doc.atoms[b.a],z=s.doc.atoms[b.b];ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(z.x,z.y);ctx.stroke()});
    ctx.lineWidth=1.5/scale;s.selection.atoms.forEach(i=>{const a=s.doc.atoms[i];ctx.beginPath();ctx.arc(a.x,a.y,9/scale,0,Math.PI*2);ctx.stroke()});
    s.selection.marks.forEach(i=>{const b=drawingBounds(drawingMarkExtent(s.doc.marks[i]));ctx.strokeRect(b.left-4,b.top-4,b.right-b.left+8,b.bottom-b.top+8)});
  }ctx.restore();
}
