let paperSession = null;
let paperApproval = null;
let paperReference = null;
const paperDirections = {references: '참고문헌', citations: '후속 인용'};
const paperKinds = {review: '리뷰', likely_original: '원 연구 후보', unknown: '유형 미확인'};
const paperUpdates = {
  retraction: '철회 확인', correction: '정정 정보 있음', notice: '정정·철회 공지', unknown: '정정·철회 미확인',
};

function paperElement(tag, value, className = '') {
  const node = document.createElement(tag);
  if (value) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function paperButton(label, action) {
  const button = paperElement('button', label, 'subtle-button');
  button.type = 'button';
  button.onclick = action;
  return button;
}

function preparePaperSearch(id) {
  if (paperSession?.id === id) {
    renderPaperResults();
    return;
  }
  paperSession = {id, papers: [], attempts: [], view: null, busy: false};
  $('paper-question').value = '';
  $('paper-status').textContent = '';
  const rows = [];
  for (let index = 1; index <= 3; index++) {
    const row = paperElement('div', '', 'paper-query-row');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('aria-label', `검색어 ${index} 보내기`);
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 250;
    input.placeholder = `검색어 ${index}`;
    input.setAttribute('aria-label', `검색어 ${index}`);
    input.oninput = () => { delete input.dataset.suggested; };
    row.append(checkbox, input);
    rows.push(row);
  }
  $('paper-query-list').replaceChildren(...rows);
  $('paper-search-history').open = false;
  updatePaperButtons();
  renderPaperResults();
}

function paperRows() {
  return [...$('paper-query-list').children].map(row => ({
    checkbox: row.querySelector('[type=checkbox]'),
    input: row.querySelector('[type=text]'),
  }));
}

function updatePaperButtons() {
  const busy = Boolean(paperSession?.busy);
  $('suggest-papers').disabled = busy;
  $('run-search').disabled = busy;
  $('paper-results').querySelectorAll('[data-paper-lookup]').forEach(button => { button.disabled = busy; });
}

async function suggestPaperSearch() {
  const session = paperSession;
  if (!session || session.busy) return;
  const question = $('paper-question').value.trim();
  if (question.length < 3) {
    $('paper-status').textContent = '연구 질문을 3자 이상 입력해 주세요.';
    $('paper-question').focus();
    return;
  }
  session.busy = true;
  updatePaperButtons();
  $('paper-status').textContent = '이 컴퓨터에서 검색어를 만드는 중…';
  try {
    const result = await api('/api/papers/suggest', 'POST', {question});
    if (paperSession !== session) return;
    if (!result.queries.length) {
      $('paper-status').textContent = '만들 수 있는 검색어가 없어요. 검색어를 직접 입력해 주세요.';
      return;
    }
    const rows = paperRows();
    const freeRows = rows.filter(({input}) => !input.value.trim() || input.dataset.suggested);
    const existing = new Set(rows.filter(row => !freeRows.includes(row)).map(({input}) => input.value.trim()));
    const suggestions = result.queries.filter(query => !existing.has(query));
    freeRows.forEach(({checkbox, input}, index) => {
      input.value = suggestions[index] || '';
      input.dataset.suggested = 'true';
      checkbox.checked = false;
    });
    $('paper-status').textContent = freeRows.length
      ? (result.source === 'basic' ? '기본 단어로 제안했어요. 내용을 확인하고 보낼 검색어에 체크하세요.' : '보낼 검색어를 확인하고 체크하세요.')
      : '직접 입력한 검색어를 유지했어요. 제안을 넣으려면 검색어 칸을 비워 주세요.';
  } catch (error) {
    if (paperSession === session) $('paper-status').textContent = error.message;
  } finally {
    session.busy = false;
    if (paperSession === session) updatePaperButtons();
  }
}

function confirmPaperLookup(session, service, values, action) {
  const dialog = $('paper-confirm-dialog');
  if (dialog.open) return;
  paperApproval = {session, action};
  $('paper-confirm-service').textContent = `${service}에 아래 내용만 보냅니다.`;
  $('paper-confirm-values').replaceChildren(...values.map(value => paperElement('li', value)));
  dialog.returnValue = '';
  dialog.showModal();
}

function runSearch() {
  const session = paperSession;
  if (!session || session.busy) return;
  const queries = [...new Set(paperRows().filter(row => row.checkbox.checked).map(row => row.input.value.trim()))];
  if (!queries.length || queries.some(query => query.length < 3 || /[\u0000-\u001f\u007f]/.test(query))) {
    $('paper-status').textContent = '3자 이상의 유효한 검색어를 하나 이상 체크해 주세요.';
    return;
  }
  confirmPaperLookup(session, 'Crossref', queries, () => performPaperLookup(
    session, '/api/papers/search', {queries}, '검색 결과',
  ));
}

function paperPublicId(paper) {
  return paper.paper_id || (paper.doi ? `DOI:${paper.doi}` : '');
}

function followPaper(paper, direction) {
  const session = paperSession;
  const identifier = paperPublicId(paper);
  if (!session || session.busy || !identifier) return;
  confirmPaperLookup(session, 'Semantic Scholar', [identifier], () => performPaperLookup(
    session, '/api/papers/citations', {identifier, direction}, paperDirections[direction], paper,
  ));
}

async function performPaperLookup(session, path, payload, title, sourcePaper = null) {
  if (paperSession !== session || session.busy) return;
  session.busy = true;
  updatePaperButtons();
  $('paper-status').textContent = '논문을 조회하는 중…';
  try {
    const result = await api(path, 'POST', payload);
    if (paperSession !== session) return;
    const time = new Date();
    const attempts = result.attempts.map(attempt => ({...attempt, time}));
    session.attempts.push(...attempts);
    const visible = new Set();
    for (const paper of result.papers) {
      if (sourcePaper) {
        if (samePaper(sourcePaper, paper)) continue;
        paper.origins = paper.origins.map(origin => ({...origin, sourceTitle: sourcePaper.title}));
      }
      visible.add(mergePaper(session.papers, paper));
    }
    const failed = attempts.filter(attempt => attempt.status === 'error');
    if (failed.length < attempts.length) {
      session.view = {title, papers: [...visible], sourceTitle: sourcePaper?.title};
    }
    renderPaperResults();
    if (failed.length) $('paper-search-history').open = true;
    $('paper-status').textContent = failed.length
      ? `${visible.size ? `${visible.size}편을 찾았습니다. ` : ''}${failed.length}건 조회 실패. 조회 기록에서 상세 내용을 확인하세요.`
      : (visible.size ? `${visible.size}편을 찾았습니다.` : '찾은 논문이 없습니다.');
  } catch (error) {
    if (paperSession === session) $('paper-status').textContent = error.message;
  } finally {
    session.busy = false;
    if (paperSession === session) updatePaperButtons();
  }
}

function paperFallbackKey(paper) {
  const author = paper.authors?.[0];
  if (!paper.title || !author || !paper.year) return '';
  const normalize = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return JSON.stringify([normalize(paper.title), normalize(author), paper.year]);
}

function samePaper(first, second) {
  if (first.doi && second.doi) return first.doi === second.doi;
  if (first.paper_id && second.paper_id && first.paper_id === second.paper_id) return true;
  const key = paperFallbackKey(first);
  return Boolean(key && key === paperFallbackKey(second));
}

function mergePaper(papers, paper) {
  const identity = papers.find(item =>
    (paper.doi && item.doi === paper.doi) ||
    (paper.paper_id && item.paper_id === paper.paper_id && !(paper.doi && item.doi)),
  );
  const candidates = identity ? [] : papers.filter(item => samePaper(item, paper));
  const existing = identity || (candidates.length === 1 ? candidates[0] : null);
  if (!existing) {
    papers.push(paper);
    return paper;
  }
  for (const key of ['doi', 'paper_id', 'year', 'journal', 'abstract', 'open_url', 'citation_count']) {
    if (existing[key] == null || existing[key] === '') existing[key] = paper[key];
  }
  if (!existing.authors?.length) existing.authors = paper.authors;
  if (!existing.url || paper.doi) existing.url = paper.url || existing.url;
  if (existing.kind === 'unknown' || paper.kind === 'review') existing.kind = paper.kind;
  if (paper.update_status === 'retraction' || existing.update_status === 'unknown') {
    existing.update_status = paper.update_status;
  }
  for (const origin of paper.origins) {
    if (!existing.origins.some(item => paperOriginText(item) === paperOriginText(origin))) {
      existing.origins.push(origin);
    }
  }
  return existing;
}

function paperOriginText(origin) {
  if (origin.query) return `${origin.provider} 검색 · ${origin.query}`;
  const source = origin.sourceTitle ? `${origin.sourceTitle} (${origin.identifier})` : origin.identifier;
  return `${origin.provider} ${paperDirections[origin.direction]} · ${source}`;
}

function paperLink(url, label) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    const link = paperElement('a', label);
    link.href = parsed.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  } catch {
    return null;
  }
}

function renderPaperResults() {
  const session = paperSession;
  const output = $('paper-results');
  const records = session.view?.papers ?? session.papers;
  const resultTitle = session.view?.title || '전체 결과';
  output.replaceChildren();
  if (records.length || session.view) {
    const header = paperElement('div', '', 'paper-results-head');
    header.append(paperElement('strong', `${resultTitle} ${records.length}편`));
    if (session.view) header.append(paperButton('전체 결과 보기', () => {
      session.view = null;
      renderPaperResults();
    }));
    output.append(header);
    if (session.view?.sourceTitle) output.append(paperElement('p', session.view.sourceTitle, 'small-note'));
  }
  records.forEach(paper => output.append(renderPaper(paper)));
  $('paper-search-history').hidden = !session.attempts.length;
  $('paper-attempts').replaceChildren(...session.attempts.map(attempt => paperElement('li',
    `${attempt.time.toLocaleString('ko-KR')} · ${paperOriginText(attempt)} · ${attempt.status === 'ok' ? `${attempt.count}편` : attempt.error}`,
  )));
}

function renderPaper(paper) {
  const row = paperElement('article', '', 'paper-result');
  const heading = paperElement('h3');
  heading.append(paperLink(paper.url, paper.title) || document.createTextNode(paper.title));
  row.append(heading);
  const metadata = [
    paper.authors?.join(', ') || '저자 미확인',
    paper.year || '연도 미확인', paper.journal || '학술지 미확인',
    paper.doi ? `DOI ${paper.doi}` : 'DOI 미확인', paperKinds[paper.kind],
    paperUpdates[paper.update_status],
  ];
  if (paper.citation_count != null) metadata.push(`인용 ${paper.citation_count}회`);
  row.append(paperElement('small', metadata.join(' · ')));
  const access = paperElement('small', paper.abstract ? '초록까지 확인' : '서지만 확인');
  const openLink = paperLink(paper.open_url, '공개 전문 링크');
  if (openLink) access.append(' · ', openLink);
  row.append(access);
  const details = document.createElement('details');
  details.append(paperElement('summary', `발견 경로 ${paper.origins.length}개`));
  const origins = document.createElement('ul');
  for (const origin of paper.origins) {
    const words = [
      ...(origin.matches?.title?.length ? [`제목: ${origin.matches.title.join(', ')}`] : []),
      ...(origin.matches?.abstract?.length ? [`초록: ${origin.matches.abstract.join(', ')}`] : []),
    ];
    origins.append(paperElement('li', [paperOriginText(origin), ...words].join(' · ')));
  }
  details.append(origins);
  row.append(details);
  if (paper.abstract) {
    const abstract = document.createElement('details');
    abstract.append(paperElement('summary', '초록 보기'), paperElement('p', paper.abstract));
    row.append(abstract);
  }
  const actions = paperElement('div', '', 'paper-result-actions');
  if (paperPublicId(paper)) {
    for (const [direction, label] of Object.entries(paperDirections)) {
      const button = paperButton(label, () => followPaper(paper, direction));
      button.dataset.paperLookup = direction;
      button.disabled = paperSession.busy;
      actions.append(button);
    }
  }
  if (currentBook() && !currentBook().archived && paperSession?.id === selectedBookId) {
    if(experiments.some(exp=>exp.notebook_id===selectedBookId&&!exp.archived))actions.append(paperButton('논문 블록으로 추가', () => openPaperReference(paper,'paper-block')));
    actions.append(paperButton('참고 자료에 추가', () => openPaperReference(paper)));
  }
  row.append(actions);
  return row;
}

async function populatePaperReferenceTargets(preferred=''){
  const reference=paperReference;if(!reference)return;
  const scope=$('paper-reference-scope').value,target=$('paper-reference-target');
  const request=++reference.targetRequest;target.replaceChildren(new Option('저장 위치를 불러오는 중…',''));target.disabled=true;
  try{
    const owner=scope==='book'?'notebook_id':'experiment_id';
    const id=scope==='book'?reference.bookId:scope;
    const plan=scope==='book'&&planningState.book?.id===id?planningState.book:await api(`/api/${scope==='book'?'notebooks':'experiments'}/${id}/planning`);
    if(paperReference!==reference||request!==reference.targetRequest)return;
    target.replaceChildren();
    for(const block of plan.blocks.filter(item=>!item.removed))target.add(new Option(`${scope==='book'?'연구 설계':'실험 전 설계'} · ${block.title}`,`plan:${block.id}`));
    if(scope!=='book'){
      target.add(new Option('실험 기록 · 참고 자료','record-references'));
      target.add(new Option('실험 기록 · 독립 논문 블록','paper-block'));
    }
    const preferredTitle=scope==='book'?'배경·자료 조사':'실험 전 참고 자료';
    const suggested=plan.blocks.find(item=>!item.removed&&item.title===preferredTitle);
    target.value=preferred&&[...target.options].some(option=>option.value===preferred)?preferred:suggested?`plan:${suggested.id}`:target.options[0]?.value||'';
    target.disabled=!target.options.length;
  }catch(error){if(paperReference===reference)$('paper-reference-error').textContent=error.message}
}

function openPaperReference(paper,preferred='') {
  if (!currentBook() || currentBook().archived || selectedBookId !== paperSession?.id) return;
  paperReference = {paper, bookId:selectedBookId, saving:false, targetRequest:0};
  const scope=$('paper-reference-scope');scope.replaceChildren(new Option(`책 · ${currentBook().title}`,'book'));
  for(const exp of experiments.filter(item=>item.notebook_id===selectedBookId&&!item.archived))scope.add(new Option(`실험 · ${recordNumber(exp)} ${exp.title}`,exp.id));
  if(preferred==='paper-block'&&scope.options.length>1)scope.selectedIndex=1;
  populatePaperReferenceTargets(preferred);
  const metadata = [paper.authors?.join(', '), paper.year, paper.journal].filter(Boolean);
  const access = paper.open_url ? '공개 전문 링크 있음, 본문 미확인' : '전문 접근 여부 미확인';
  const matches = [...new Set(paper.origins.flatMap(origin => [
    ...(origin.matches?.title || []), ...(origin.matches?.abstract || []),
  ]))];
  const reason = matches.length ? `제목·초록에 일치한 검색어: ${matches.join(', ')}` : '';
  $('paper-reference-draft').value = [
    `자료명: ${paper.title}`,
    metadata.length ? `서지 정보: ${metadata.join(' · ')}` : '',
    paper.doi ? `DOI: ${paper.doi}` : '',
    paper.url ? `출처: ${paper.url}` : '',
    `열람 상태: ${access} (${paper.abstract ? '초록까지 확인' : '서지만 확인'})`,
    paper.open_url ? `공개 전문 링크: ${paper.open_url}` : '',
    paper.update_status !== 'unknown' ? `상태: ${paperUpdates[paper.update_status]}` : '',
    `선정 이유: ${reason}`,
  ].filter(Boolean).join('\n');
  $('paper-save-path').checked = false;
  $('paper-reference-error').textContent = '';
  $('paper-reference-dialog').showModal();
}

async function savePaperReference(event) {
  event.preventDefault();
  const reference = paperReference;
  if (!reference || reference.saving) return;
  let draft = $('paper-reference-draft').value.trim();
  if (!draft) {
    $('paper-reference-error').textContent = '저장할 내용을 입력해 주세요.';
    return;
  }
  if ($('paper-save-path').checked) {
    draft += '\n발견 경로:\n' + reference.paper.origins.map(origin => `- ${paperOriginText(origin)}`).join('\n');
  }
  reference.saving = true;
  $('paper-reference-save').disabled = true;
  $('paper-reference-cancel').disabled = true;
  $('paper-reference-error').textContent = '';
  try {
    if(selectedBookId!==reference.bookId||!currentBook()||currentBook().archived)throw new Error('이 책을 다시 열어 주세요.');
    const scope=$('paper-reference-scope').value,target=$('paper-reference-target').value;
    if(!target)throw new Error('저장할 위치를 선택해 주세요.');
    if(scope==='book'){
      if(!target.startsWith('plan:'))throw new Error('책 설계 블록을 선택해 주세요.');
      const saved=await api(`/api/notebooks/${reference.bookId}/planning/${target.slice(5)}/append-reference`,'POST',{draft});
      if(planningState.book?.id===reference.bookId){planningState.book={id:reference.bookId,...saved};renderPlanning('book')}
    }else{
      const exp=experiments.find(item=>item.id===scope&&item.notebook_id===reference.bookId&&!item.archived);
      if(!exp)throw new Error('이 책의 실험을 선택해 주세요.');
      if(target.startsWith('plan:'))await api(`/api/experiments/${exp.id}/planning/${target.slice(5)}/append-reference`,'POST',{draft});
      else if(target==='record-references')await api(`/api/experiments/${exp.id}/paper-references`,'POST',{draft});
      else if(target==='paper-block')await api(`/api/experiments/${exp.id}/blocks`,'POST',{kind:'reference',category:'references',title:reference.paper.title||'논문 레퍼런스',url:reference.paper.url||(reference.paper.doi?`https://doi.org/${reference.paper.doi}`:''),content:draft});
      else throw new Error('저장할 위치를 선택해 주세요.');
      if(contentsQuery)requestContentsSearch();
    }
    $('paper-reference-dialog').close();
    $('paper-status').textContent = '선택한 책·실험의 참고 자료에 저장했습니다.';
  } catch (error) {
    $('paper-reference-error').textContent = error.message;
  } finally {
    reference.saving = false;
    $('paper-reference-save').disabled = false;
    $('paper-reference-cancel').disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('suggest-papers').onclick = suggestPaperSearch;
  $('paper-confirm-dialog').addEventListener('close', event => {
    const approval = paperApproval;
    paperApproval = null;
    if (event.target.returnValue === 'send' && approval?.session === paperSession) approval.action();
  });
  $('paper-reference-form').onsubmit = savePaperReference;
  $('paper-reference-scope').onchange=()=>populatePaperReferenceTargets();
  $('paper-reference-cancel').onclick = () => $('paper-reference-dialog').close();
  $('paper-reference-dialog').addEventListener('cancel', event => {
    if (paperReference?.saving) event.preventDefault();
  });
  $('paper-reference-dialog').addEventListener('close', () => { paperReference = null; });
});
