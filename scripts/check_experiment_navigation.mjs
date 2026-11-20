import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const functions=source.slice(source.indexOf('function experimentsInCurrentBook(){'),source.indexOf('function saveSection('));
const records=[{id:'b',number:6,notebook_id:'book'},{id:'a',number:5,notebook_id:'book'},{id:'old',number:4,notebook_id:'book',archived:1},{id:'other',number:7,notebook_id:'another'}];
function fixture(save=async()=>{}){
  const elements={},events=[];
  const context={experiments:records,current:records[1],activeSection:'observations',recordNavigationPending:false,contentsSearching:false,contentsQuery:'',
    filterContentsRecords:bookId=>records.filter(e=>e.notebook_id===bookId&&!e.archived).sort((a,b)=>a.number-b.number),
    $:id=>elements[id]??(elements[id]={}),recordNumber:e=>String(e.number),
    persistRecordEdits:async()=>{events.push('save');await save()},toast:message=>events.push(message),
    openExperiment:async id=>{events.push('open:'+id);context.current=records.find(e=>e.id===id)},
    turnToSection:key=>events.push('section:'+key)};
  vm.createContext(context);vm.runInContext(functions,context);return {context,elements,events};
}
const normal=fixture();normal.context.renderExperimentNavigation();
assert.equal(normal.elements['previous-page'].disabled,true);
assert.equal(normal.elements['next-page'].disabled,false);
assert.equal(normal.elements['page-folio'].textContent,'실험 1 / 2');
await normal.context.navigateExperiment(1);
assert.deepEqual(normal.events,['save','open:b','section:observations']);
assert.equal(normal.elements['next-page'].disabled,true);
await normal.context.navigateExperiment(-1);assert.equal(normal.context.current.id,'a');
const failed=fixture(async()=>{throw Error('save failed')});
await failed.context.navigateExperiment(1);
assert.equal(failed.context.current.id,'a');assert.equal(failed.events.some(e=>e.startsWith('open:')),false);
assert.equal(failed.context.recordNavigationPending,false);
let release;const waiting=fixture(()=>new Promise(resolve=>{release=resolve}));
const pending=waiting.context.navigateExperiment(1);
await waiting.context.navigateExperiment(1);
assert.deepEqual(waiting.events,['save']);release();await pending;
assert.equal(waiting.events.filter(e=>e.startsWith('open:')).length,1);
console.log('Passed: book scope, number order, archive exclusion, boundaries, preserved section, save-before-open, failed-save stays put, rapid-click guard.');
