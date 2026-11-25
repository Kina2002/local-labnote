let books = [];
let topics = [];
let selectedBookId = null;
let archiveReturnBookId = null;
let deleteTarget = null;
let deletionBusy = false;
let createAfterNewBook = false;

function openBookDialog(forExperiment = false) {
  createAfterNewBook = forExperiment;
  $('new-book-title').value = '';
  $('new-book-source').value = '';
  $('book-dialog').showModal();
}

function currentBook() {
  return books.find(book => book.id === selectedBookId);
}

function openDeleteDialog(kind, id, title) {
  deleteTarget = {kind, id, title};
  const detail = kind === 'experiment'
    ? '본문과 첨부파일도 영구 삭제됩니다. 이 작업은 되돌릴 수 없습니다.'
    : kind === 'topic'
      ? '이 주제에 속한 실험과 보관 기록은 남고 ‘주제 없음’으로 이동합니다.'
      : '책의 주제, 실험, 보관 기록과 첨부파일이 모두 영구 삭제됩니다. 이 작업은 되돌릴 수 없습니다.';
  $('delete-description').textContent = `${title}\n${detail}`;
  $('delete-confirmation').value = '';
  $('delete-error').textContent = '';
  $('delete-submit').disabled = true;
  $('delete-dialog').showModal();
  $('delete-confirmation').focus();
}

function visibleExperiments() {
  return selectedBookId ? filterContentsRecords(selectedBookId) : [];
}

async function refreshShelf() {
  books = await api('/api/notebooks');
  topics = await api('/api/topics');
  if (selectedBookId && !currentBook()) selectedBookId = null;
  renderBookNav();
  renderShelf();
  if (selectedBookId && !current) renderBookHome();
  if (!selectedBookId && !current) showShelf();
}

function renderBookNav() {
  syncContentsBook();
  const nav = $('book-nav');
  nav.innerHTML = '';
  for (const book of books) {
    const button = document.createElement('button');
    button.className = 'book-nav-item' + (book.id === selectedBookId ? ' active' : '');
    button.innerHTML = `<span class="book-nav-icon">▤</span><span class="book-nav-title">${escapeHtml(book.title)}</span><small>${book.experiment_count}</small>`;
    button.onclick = () => showBook(book.id);
    nav.append(button);
  }
  $('contents-heading').textContent = currentBook() ? '이 책의 실험' : '실험 목차';
}

function renderShelf() {
  const box = $('shelf-books');
  box.innerHTML = '';
  for (const book of books) {
    const button = document.createElement('button');
    button.className = 'shelf-book';
    button.innerHTML = `<span class="shelf-book-mark">✳</span><span class="shelf-book-title">${escapeHtml(book.title)}</span><span class="shelf-book-count">기록 ${book.experiment_count}개</span>`;
    button.onclick = () => showBook(book.id);
    box.append(button);
  }
}

function showShelf() {
  selectedBookId = null;
  current = null;
  planningState.book = null;
  $('shelf').classList.remove('hidden');
  $('book-home').classList.add('hidden');
  $('welcome').classList.add('hidden');
  $('notebook').classList.add('hidden');
  $('top-status').textContent = '책을 선택해 주세요';
  renderBookNav();
  renderSidebar();
}

function renderBookHome() {
  const book = currentBook();
  if (!book) return showShelf();
  if(planningState.book?.id!==book.id)loadPlanning('book',book.id).catch(error=>toast(error.message));
  $('book-title').textContent = book.title;
  $('top-status').textContent = book.title;
  $('book-overview').textContent = book.overview || '';
  $('book-overview').classList.toggle('hidden', !book.overview);
  $('book-count').textContent = `기록 ${book.experiment_count}개`;
  const source = $('book-source');
  source.classList.toggle('hidden', !book.source_url);
  if (book.source_url) source.href = book.source_url;
  const list = $('book-experiments');
  list.innerHTML = '';
  const bookTopics = topics.filter(topic => topic.notebook_id === selectedBookId);
  const visible = visibleExperiments();
  const shown = [...bookTopics.map(topic => visible.filter(exp => exp.topic_id === topic.id)).flat(), ...visible.filter(exp => !exp.topic_id)];
  const pagination=paginateContents(shown,bookContentsPage);
  bookContentsPage=pagination.page;
  if (!shown.length && !bookTopics.length) {
    const empty=document.createElement('p');empty.className='book-empty';empty.textContent=contentsEmptyMessage();list.append(empty);
  } else {
    for (const topic of [...bookTopics, {id: '', title: '주제 없음'}]) {
      const records = pagination.records.filter(exp => (exp.topic_id || '') === topic.id);
      if (!records.length && (topic.id === '' || contentsQuery || bookContentsPage !== 1)) continue;
      const group = document.createElement('section'); group.className = 'topic-group';
      const head = document.createElement('div'); head.className = 'topic-group-head';
      const title = document.createElement('h3'); title.textContent = topic.title;
      const actions = document.createElement('div'); actions.className = 'topic-group-actions';
      if (topic.id) {
        const rename = document.createElement('button'); rename.type = 'button'; rename.className = 'text-button'; rename.textContent = '이름 변경'; rename.onclick = () => openTopicDialog(topic); actions.append(rename);
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button danger-action'; remove.textContent = '주제 삭제'; remove.onclick = () => openDeleteDialog('topic', topic.id, topic.title); actions.append(remove);
      }
      const add = document.createElement('button'); add.type = 'button'; add.className = 'text-button'; add.textContent = '＋ 실험'; add.onclick = () => openCreate(topic.id); actions.append(add);
      head.append(title, actions); group.append(head);
      for (const exp of records) {
        const row=makeExperimentLink(exp); row.title=`${recordNumber(exp)} · ${exp.title}`; group.append(row);
      }
      list.append(group);
    }
    if (!shown.length) {
      const empty = document.createElement('p'); empty.className = 'book-empty'; empty.textContent = contentsEmptyMessage(); list.append(empty);
    }
  }
  $('book-list-summary').textContent=contentsSearching?'검색 중…':contentsSearchError?'검색 오류':shown.length?`${contentsQuery?'검색 결과':'전체'} ${shown.length}개 · ${pagination.start+1}–${pagination.start+pagination.records.length}번째 표시`:'표시할 실험이 없습니다.';
  $('book-pagination').hidden=!shown.length||contentsSearching||Boolean(contentsSearchError);
  $('book-previous-page').disabled=bookContentsPage===1;
  $('book-next-page').disabled=bookContentsPage===pagination.count;
  const numbers=$('book-page-numbers');numbers.innerHTML='';
  const first=Math.max(1,Math.min(bookContentsPage-2,pagination.count-4));
  const pages=new Set([1,pagination.count]);
  for(let number=first;number<=Math.min(pagination.count,first+4);number++)pages.add(number);
  let previous=0;
  for(const number of [...pages].sort((a,b)=>a-b)){
    if(previous&&number-previous>1){const gap=document.createElement('span');gap.textContent='…';numbers.append(gap)}
    const button=document.createElement('button');button.type='button';button.textContent=number;button.setAttribute('aria-label',`목차 ${number}페이지`);
    if(number===bookContentsPage)button.setAttribute('aria-current','page');
    button.onclick=()=>changeBookContentsPage(number);numbers.append(button);previous=number;
  }
}

function changeBookContentsPage(page){
  bookContentsPage=paginateContents(visibleExperiments(),page).page;
  renderBookHome();document.querySelector('.book-contents').scrollIntoView({block:'start'});
}

function showBook(id) {
  selectedBookId = id;
  syncContentsBook();
  current = null;
  $('shelf').classList.add('hidden');
  $('book-home').classList.remove('hidden');
  $('welcome').classList.add('hidden');
  $('notebook').classList.add('hidden');
  $('top-status').textContent = currentBook()?.title || '';
  renderBookHome();
  renderBookNav();
  renderSidebar();
}

document.addEventListener('DOMContentLoaded', () => {
  $('delete-record').onclick = async () => {
    if (!current) return;
    const id = current.id;
    try {
      await persistRecordEdits();
      if (current?.id === id) openDeleteDialog('experiment', id, current.title);
    } catch (error) { toast(error.message); }
  };
  $('delete-book').onclick = () => {
    const book = currentBook();
    if (book) openDeleteDialog('notebook', book.id, book.title);
  };
  $('archive-book').onclick = async () => {
    const book = currentBook();
    if (!book) return;
    $('archive-book').disabled = true;
    try {
      await api(`/api/notebooks/${book.id}/archive`, 'POST', {});
      showShelf();
      await refreshList();
      toast('책을 보관했습니다. 보관한 책·기록에서 복원할 수 있습니다.');
    } catch (error) { toast(error.message); }
    finally { $('archive-book').disabled = false; }
  };
  $('delete-cancel').onclick = () => { if (!deletionBusy) $('delete-dialog').close(); };
  $('delete-dialog').addEventListener('cancel', event => { if (deletionBusy) event.preventDefault(); });
  $('delete-confirmation').oninput = () => { $('delete-submit').disabled = $('delete-confirmation').value.trim() !== '삭제'; };
  $('delete-form').onsubmit = async event => {
    event.preventDefault();
    if (deletionBusy || !deleteTarget || $('delete-confirmation').value.trim() !== '삭제') return;
    const target = deleteTarget, button = $('delete-submit');
    deletionBusy = true;
    button.disabled = true;
    $('delete-cancel').disabled = true;
    try {
      const path = target.kind === 'experiment' ? 'experiments' : target.kind === 'topic' ? 'topics' : 'notebooks';
      const result = await api(`/api/${path}/${target.id}/delete`, 'POST', {title:target.title});
      $('delete-dialog').close();
      deleteTarget = null;
      if (target.kind === 'experiment') {
        const bookId = current?.notebook_id;
        if (bookId) showBook(bookId);
        await refreshList();
        toast('실험을 삭제했습니다.');
      } else if (target.kind === 'topic') {
        await refreshList();
        toast(result.records_moved ? `주제를 삭제하고 기록 ${result.records_moved}개를 ‘주제 없음’으로 옮겼습니다.` : '주제를 삭제했습니다.');
      } else {
        if ($('archive-dialog').open) $('archive-dialog').close();
        showShelf();
        await refreshList();
        toast(result.records_deleted ? `책과 기록 ${result.records_deleted}개를 삭제했습니다.` : '책을 삭제했습니다.');
      }
    } catch (error) { $('delete-error').textContent = error.message; }
    finally {
      deletionBusy = false;
      $('delete-cancel').disabled = false;
      button.disabled = $('delete-confirmation').value.trim() !== '삭제';
    }
  };
  $('open-archive').onclick = () => showArchive();
  $('archive-record').onclick = async () => {
    if (!current || current.archived) return;
    const id = current.id, bookId = current.notebook_id;
    $('archive-record').disabled = true;
    try {
      await persistRecordEdits();
      await api(`/api/experiments/${id}/archive`, 'POST', {});
      if (current?.id === id) showBook(bookId);
      await refreshList();
      toast('보관했습니다. 왼쪽 보관한 기록에서 다시 볼 수 있어요.');
    } catch(error) { toast(error.message); }
    finally { $('archive-record').disabled = false; }
  };
  $('close-record').onclick = async () => {
    if (!current) return;
    const id = current.id, bookId = current.notebook_id, archived = Boolean(current.archived);
    try {
      if (!archived) await persistRecordEdits();
      if (current?.id !== id) return;
      if (archived) {
        if (archiveReturnBookId) showBook(archiveReturnBookId); else showShelf();
        await showArchive(archiveReturnBookId);
      } else { await refreshList(); showBook(bookId); }
    } catch(error) { toast(error.message); }
  };
  $('close-archive').onclick = () => $('archive-dialog').close();
  $('restore-record').onclick = async () => {
    if (!current?.archived) return;
    const id = current.id;
    $('restore-record').disabled = true;
    try {
      await api(`/api/experiments/${id}/restore`, 'POST', {});
      await refreshList();
      await openExperiment(id);
      toast('기록을 목록으로 복원했습니다.');
    } catch(error) { toast(error.message); }
    finally { $('restore-record').disabled = false; }
  };
  $('repeat-experiment').onclick = async () => {
    if (!current) return;
    const id = current.id;
    try {
      await saveQueue;
      const entry = await api(`/api/experiments/${id}/repeat`, 'POST', {});
      await refreshList();
      await openExperiment(entry.id);
      toast('새 회차를 만들었습니다. 실제 수행 조건과 날짜를 확인해 주세요.');
    } catch (error) { toast(error.message); }
  };
  $('open-shelf').onclick = showShelf;
  $('crumb-book').onclick = () => showBook(selectedBookId);
  $('new-book').onclick = () => openBookDialog();
  let renamingBookId = null, renamingBookBusy = false;
  $('rename-book').onclick = () => {
    const book = currentBook();
    if (!book) return;
    renamingBookId = book.id;
    $('rename-book-title').value = book.title;
    $('rename-book-error').textContent = '';
    $('rename-book-dialog').showModal();
    $('rename-book-title').focus();
    $('rename-book-title').select();
  };
  const closeRenameBook = () => { if (!renamingBookBusy) $('rename-book-dialog').close(); };
  $('rename-book-close').onclick = closeRenameBook;
  $('rename-book-cancel').onclick = closeRenameBook;
  $('rename-book-dialog').addEventListener('cancel', event => { if (renamingBookBusy) event.preventDefault(); });
  $('rename-book-form').onsubmit = async event => {
    event.preventDefault();
    if (renamingBookBusy) return;
    const title = $('rename-book-title').value.trim();
    if (!title) { $('rename-book-error').textContent = '책 제목을 입력해 주세요.'; return; }
    renamingBookBusy = true;
    for (const control of $('rename-book-form').elements) control.disabled = true;
    try {
      const result = await api(`/api/notebooks/${renamingBookId}/title`, 'POST', {title});
      const book = books.find(item => item.id === result.id);
      if (book) book.title = result.title;
      renderBookNav();
      renderShelf();
      if (selectedBookId && !current) renderBookHome();
      if (current) $('crumb-book').textContent = currentBook()?.title || '책';
      $('rename-book-dialog').close();
      toast('책 제목을 변경했습니다.');
    } catch (error) { $('rename-book-error').textContent = error.message; }
    finally {
      renamingBookBusy = false;
      for (const control of $('rename-book-form').elements) control.disabled = false;
    }
  };
  $('book-new-experiment').onclick = () => openCreate();
  $('new-topic').onclick = () => openTopicDialog();
  $('new-topic-from-create').onclick = () => openTopicDialog();
  $('topic-dialog').addEventListener('close', async () => {
    if ($('topic-dialog').returnValue !== 'save') return;
    const title = $('topic-title').value.trim();
    if (!title) return;
    try {
      const topic = editingTopicId
        ? await api(`/api/topics/${editingTopicId}`, 'POST', {title})
        : await api('/api/topics', 'POST', {notebook_id: selectedBookId, title});
      await refreshShelf();
      fillTopicSelect($('new-experiment-topic'), topic.id);
      if (current && current.notebook_id === selectedBookId) fillTopicSelect($('record-topic'), current.topic_id || '');
      toast(editingTopicId ? '주제 이름을 변경했습니다.' : '새 주제를 만들었습니다.');
    } catch (error) { toast(error.message); }
  });
  $('book-dialog').addEventListener('close', async () => {
    const openExperimentAfterCreate = createAfterNewBook;
    createAfterNewBook = false;
    if ($('book-dialog').returnValue !== 'create') return;
    try {
      const book = await api('/api/notebooks', 'POST', {
        title: $('new-book-title').value,
        source_url: $('new-book-source').value.trim(),
      });
      await refreshShelf();
      showBook(book.id);
      toast('새 책을 만들었습니다.');
      if (openExperimentAfterCreate) openCreate();
    } catch (error) {
      toast(error.message);
    }
  });
});

function updateRecordHeader() {
  const literature = current.record_type === 'literature';
  const source = current.record_type === 'source';
  const archived = Boolean(current.archived);
  $('experiment-date').disabled = literature || source || archived;
  $('experiment-start-time').disabled = literature || source || archived;
  $('experiment-title').readOnly = archived;
  $('record-code').readOnly = archived;
  $('record-topic').disabled = archived;
  $('restore-record').classList.toggle('hidden', !archived);
  $('archive-record').classList.toggle('hidden', archived);
  $('repeat-experiment').classList.toggle('hidden', archived);
  for(const textarea of document.querySelectorAll('#sections textarea')) textarea.readOnly = archived;
  for(const button of document.querySelectorAll('#sections .add-file, #sections .lock-button')) button.disabled = archived;
  $('experiment-date-label').textContent = literature ? '수행일 (원문 미상)' : source ? '원자료의 날짜' : '실제 시작 날짜 (설계 중이면 비워 두세요)';
  $('record-kind').textContent = literature ? 'LITERATURE RECONSTRUCTION' : source ? 'PUBLIC RESEARCH RECORD' : 'EXPERIMENT RECORD';
  let siblings = $('record-siblings');
  if (!siblings) { siblings=document.createElement('div'); siblings.id='record-siblings'; $('repeat-experiment').after(siblings); }
  siblings.innerHTML='';
  const related=experiments.filter(e=>e.series_id===current.series_id);
  if(related.length>1) for(const entry of related){
    const button=document.createElement('button'); button.className='subtle-button';
    button.textContent=entry.record_type==='literature'?'참고한 문헌 조건':entry.record_type==='source'?'공개 원기록':`${entry.run_number}회차`;
    button.disabled=entry.id===current.id; button.onclick=()=>openExperiment(entry.id); siblings.append(button);
  }
  $('record-context').textContent = literature
    ? '문헌 재구성 · 직접 수행한 실험이 아닙니다. 논문에 개별 수행일과 반복 회차가 없어 미상으로 표시합니다. 방법·관찰·해석의 출처를 각 항목에서 확인하세요.'
    : source ? '공개 연구 기록을 원자료에 따라 정리했습니다. 날짜는 원자료에서 확인된 경우에만 표시하고, 실제 수행 내용과 출처를 각 항목에서 확인할 수 있습니다.'
    : `${current.run_number || 1}회차 · ${current.record_type === 'plan' ? '새 회차 초안입니다. 이전 기록의 목적·방법·참고 자료만 가져왔습니다. 실제 수행 날짜와 조건을 확인하고 관찰·결과를 새로 기록하세요.' : '이번 수행의 조건·시간·관찰·결과를 기록하세요. 반복 수행은 별도 회차로 만듭니다.'}`;
  $('repeat-experiment').textContent = literature || source ? '이 조건으로 새 실험 기록' : '다음 회차 기록';
  if (archived) {
    $('experiment-date-label').textContent = '기존 기록의 날짜';
    $('top-status').textContent = `${recordNumber(current)} · 보관된 기록`;
    $('record-context').textContent = '보관된 기록 · 내용과 첨부파일을 확인할 수 있습니다. 복원하면 다시 목록에 표시되고 수정할 수 있습니다. 오른쪽 위 닫기를 누르면 보관 목록으로 돌아갑니다.';
    $('record-kind').textContent = 'ARCHIVED RECORD';
    $('record-siblings').innerHTML = '';
  }
}

async function showArchive(scope = selectedBookId) {
  try {
    const [all, archivedBooks] = await Promise.all([
      api('/api/archived-experiments'), api('/api/archived-notebooks')
    ]);
    const records = scope ? all.filter(e=>e.notebook_id===scope) : all;
    const bookList = $('archived-books');
    bookList.innerHTML = '';
    $('archived-books-section').classList.toggle('hidden', !archivedBooks.length);
    for (const book of archivedBooks) {
      const row = document.createElement('div');
      row.className = 'archived-book-row';
      const label = document.createElement('div');
      label.innerHTML = `<strong>${escapeHtml(book.title)}</strong><small>기록 ${book.experiment_count}개 · 복원하면 책장에 다시 표시됩니다.</small>`;
      const restore = document.createElement('button');
      restore.type = 'button'; restore.className = 'subtle-button'; restore.textContent = '책 복원';
      restore.onclick = async () => {
        restore.disabled = true;
        try {
          await api(`/api/notebooks/${book.id}/restore`, 'POST', {});
          $('archive-dialog').close();
          await refreshList();
          toast('책을 복원했습니다.');
        } catch (error) { toast(error.message); restore.disabled = false; }
      };
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'subtle-button danger-action'; remove.textContent = '책 삭제';
      remove.onclick = () => { $('archive-dialog').close(); openDeleteDialog('notebook', book.id, book.title); };
      row.append(label, restore, remove); bookList.append(row);
    }
    $('archive-scope').textContent = `${books.find(b=>b.id===scope)?.title || '전체 책'} · ${records.length}개. 기록을 선택하면 내용과 첨부파일을 볼 수 있습니다.`;
    const list = $('archive-list');
    list.innerHTML = '';
    if (!records.length) list.textContent = '보관한 기록이 없습니다.';
    for (const record of records) {
      const button = makeExperimentLink(record);
      button.querySelector('.list-date').textContent = '보관된 기록 · 열어서 확인';
      button.onclick = async () => { archiveReturnBookId = scope; $('archive-dialog').close(); await openExperiment(record.id); };
      list.append(button);
    }
    $('archive-dialog').showModal();
  } catch(error) { toast(error.message); }
}

async function persistRecordEdits() {
  if (!current || current.archived) return;
  await flushPlanning('experiment');
  const id = current.id;
  const title = $('experiment-title').value.trim() || current.title;
  const date = $('experiment-date').value;
  const startTime = $('experiment-start-time').value;
  const recordCode = $('record-code').value.trim();
  const topicId = $('record-topic').value || null;
  const contents = Object.fromEntries(Object.keys(labels).map(key=>[key,$(`section-${key}`).querySelector('textarea').value]));
  const customEdits = (current.blocks||[]).map(block=>{
    const element=$(`section-${block.id}`);
    return {id:block.id,title:element.querySelector('.custom-title')?.value||block.title,content:element.querySelector('.custom-content').value,url:element.querySelector('.custom-url').value,category:block.category};
  });
  await saveQueue;
  if (current?.id !== id) throw new Error('열린 기록이 바뀌었습니다. 다시 시도해 주세요.');
  for (const key of Object.keys(labels)) {
    if(contents[key] !== current.sections[key].content) {
      current = await api(`/api/experiments/${id}/sections/${key}`, 'POST', {content:contents[key]});
    }
  }
  for(const edit of customEdits){
    const saved=current.blocks.find(block=>block.id===edit.id);
    const patch=Object.fromEntries(['title','content','url','category'].filter(field=>edit[field]!==saved[field]).map(field=>[field,edit[field]]));
    if(Object.keys(patch).length)current=await api(`/api/experiments/${id}/blocks/${edit.id}`,'POST',patch);
  }
  if(title !== current.title || date !== current.experiment_date || startTime !== (current.start_time||'') || recordCode !== (current.record_code || '') || topicId !== (current.topic_id || null)) {
    current = await api(`/api/experiments/${id}`, 'POST', {title, experiment_date:date, start_time:startTime, record_code:recordCode, topic_id:topicId});
  }
}

let editingTopicId = null;
function fillTopicSelect(select, selected = '') {
  select.replaceChildren();
  const blank = new Option('주제 없음', ''); select.add(blank);
  for (const topic of topics.filter(item => item.notebook_id === selectedBookId)) select.add(new Option(topic.title, topic.id));
  select.value = selected || '';
}
function openTopicDialog(topic = null) {
  if (!selectedBookId) return;
  editingTopicId = topic?.id || null;
  $('topic-dialog-title').textContent = topic ? '주제 이름 변경' : '새 주제';
  $('topic-title').value = topic?.title || '';
  $('topic-dialog').showModal();
  $('topic-title').focus();
}
