let contentsQuery='',contentsSort='number-asc',contentsSearchIds=null,contentsSearching=false,contentsSearchError='';
let contentsBookId=null,contentsRequest=0,contentsTimer=null;
let bookContentsPage=1;
const bookContentsPageSize=10;
function paginateContents(records,page){
  const count=Math.max(1,Math.ceil(records.length/bookContentsPageSize));
  const selected=Math.max(1,Math.min(count,page));
  const start=(selected-1)*bookContentsPageSize;
  return {page:selected,count,start,records:records.slice(start,start+bookContentsPageSize)};
}
function syncContentsControls(){
  for(const id of ['contents-search','book-contents-search']){
    const input=$(id);input.disabled=!selectedBookId;
    if(document.activeElement!==input&&input.value!==contentsQuery)input.value=contentsQuery;
  }
  for(const id of ['contents-sort','book-contents-sort']){$(id).disabled=!selectedBookId;$(id).value=contentsSort}
  $('clear-contents-search').hidden=!contentsQuery;$('clear-book-contents-search').hidden=!contentsQuery;
}
function sortContentsRecords(records,sort=contentsSort){
  const [field,direction]=sort.split('-'),sign=direction==='desc'?-1:1;
  return [...records].sort((a,b)=>{
    let result=0;
    if(field==='date'){
      if(!a.experiment_date!==!b.experiment_date)return a.experiment_date?-1:1;
      result=(a.experiment_date||'').localeCompare(b.experiment_date||'');
    }else if(field==='title')result=a.title.localeCompare(b.title,'ko',{numeric:true,sensitivity:'base'});
    else {
      const code = exp => exp.record_code || (exp.record_type === 'literature' ? `LIT-${String(exp.number).padStart(3,'0')}` : `EXP-${String(exp.number).padStart(3,'0')}`);
      result=code(a).localeCompare(code(b),'ko',{numeric:true,sensitivity:'base'});
    }
    return result*sign||a.number-b.number;
  });
}
function filterContentsRecords(bookId){
  const records=experiments.filter(exp=>exp.notebook_id===bookId&&!exp.archived);
  return sortContentsRecords(contentsQuery?records.filter(exp=>contentsSearchIds?.has(exp.id)):records);
}
function syncContentsBook(){
  if(contentsBookId!==selectedBookId){
    contentsBookId=selectedBookId;contentsRequest++;clearTimeout(contentsTimer);
    contentsQuery='';contentsSearchIds=null;contentsSearching=false;contentsSearchError='';bookContentsPage=1;
    $('contents-search').value='';$('book-contents-search').value='';
  }
  syncContentsControls();
  document.querySelector('.sidebar').classList.toggle('searching',Boolean(contentsQuery));
}
function updateContentsViews(){
  renderSidebar();
  if(!$('book-home').classList.contains('hidden'))renderBookHome();
  if(current)renderExperimentNavigation();
}
async function requestContentsSearch(){
  clearTimeout(contentsTimer);
  const ticket=++contentsRequest,bookId=selectedBookId,query=contentsQuery;
  if(!bookId||!query){contentsSearchIds=null;contentsSearching=false;contentsSearchError='';updateContentsViews();return}
  contentsSearching=true;contentsSearchError='';updateContentsViews();
  try{
    const records=await api(`/api/experiments?notebook_id=${encodeURIComponent(bookId)}&q=${encodeURIComponent(query)}`);
    if(ticket!==contentsRequest||bookId!==selectedBookId)return;
    contentsSearchIds=new Set(records.map(exp=>exp.id));contentsSearching=false;updateContentsViews();
  }catch(error){
    if(ticket!==contentsRequest)return;
    contentsSearchIds=new Set();contentsSearching=false;contentsSearchError=error.message;updateContentsViews();
  }
}
function queueContentsSearch(value){
  contentsQuery=value.trim();bookContentsPage=1;contentsRequest++;clearTimeout(contentsTimer);
  contentsSearchIds=null;contentsSearching=Boolean(contentsQuery);contentsSearchError='';syncContentsBook();updateContentsViews();
  if(contentsQuery)contentsTimer=setTimeout(requestContentsSearch,180);
}
function contentsEmptyMessage(){
  if(contentsSearching)return '기록을 찾고 있어요…';
  if(contentsSearchError)return '검색하지 못했어요. 검색어를 다시 입력해 주세요.';
  if(contentsQuery)return '검색 결과가 없어요. 다른 검색어로 찾아보세요.';
  return selectedBookId?'아직 실험 기록이 없어요.':'책을 선택하면 실험을 검색할 수 있어요.';
}
function renderContentsStatus(shown){
  syncContentsBook();
  const total=experiments.filter(exp=>exp.notebook_id===selectedBookId&&!exp.archived).length;
  $('contents-results').textContent=!selectedBookId?'책 안의 기록 검색':contentsSearching?'검색 중…':contentsSearchError?'검색 오류':contentsQuery?`검색 결과 ${shown.length} / ${total}개`:`실험 ${total}개`;
}
document.addEventListener('DOMContentLoaded',()=>{
  $('book-contents-sort').innerHTML=$('contents-sort').innerHTML;
  for(const [inputId,clearId] of [['contents-search','clear-contents-search'],['book-contents-search','clear-book-contents-search']]){
    const input=$(inputId);
    input.addEventListener('input',()=>queueContentsSearch(input.value));
    input.addEventListener('keydown',event=>{if(event.key==='Escape'){input.value='';queueContentsSearch('')}});
    $(clearId).onclick=()=>{input.value='';queueContentsSearch('');input.focus()};
  }
  for(const id of ['contents-sort','book-contents-sort'])$(id).onchange=()=>{contentsSort=$(id).value;bookContentsPage=1;syncContentsControls();updateContentsViews()};
  $('book-previous-page').onclick=()=>changeBookContentsPage(bookContentsPage-1);
  $('book-next-page').onclick=()=>changeBookContentsPage(bookContentsPage+1);
});
