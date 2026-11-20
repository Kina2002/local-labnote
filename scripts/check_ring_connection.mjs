import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const context=vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../web/drawing.js',import.meta.url),'utf8'),context);
const {drawingRingPlacement:place,addDrawingRing:add,nearestDrawingAtom:nearest}=context;
const fixture=()=>({width:960,height:440,atoms:[{x:300,y:220,label:'C'},{x:364,y:220,label:'C'}],bonds:[{a:0,b:1,order:1}],marks:[]});
for(const kind of ['6','5','benzene']){
  const d=fixture(),before=JSON.stringify(d),plan=place(d,{x:369,y:224},kind);
  assert.equal(plan.anchor,1);assert.equal(plan.valid,true);assert.equal(JSON.stringify(d),before,'preview must not mutate');
  assert(plan.points.slice(1).every(a=>a.x>d.atoms[1].x),'auto placement points away from the existing bond');
  assert(add(d,plan,kind));const n=kind==='5'?5:6;
  assert.equal(d.atoms.length,n+1);assert.equal(d.bonds.length,n+1);
  assert.equal(d.atoms.filter(a=>Math.hypot(a.x-364,a.y-220)<.01).length,1,'no duplicate anchor');
  assert.equal(d.bonds.filter(b=>b.a===1||b.b===1).length,3,'one external bond, two ring bonds');
  assert.equal(d.bonds.filter(b=>b.order===2).length,kind==='benzene'?3:0);
  const visited=new Set([0]);for(let pass=0;pass<d.atoms.length;pass++)for(const b of d.bonds){if(visited.has(b.a))visited.add(b.b);if(visited.has(b.b))visited.add(b.a)}
  assert.equal(visited.size,d.atoms.length,'all atoms are connected');
  for(const bond of d.bonds)assert(Math.abs(Math.hypot(d.atoms[bond.a].x-d.atoms[bond.b].x,d.atoms[bond.a].y-d.atoms[bond.b].y)-64)<.001);
}
const reverse=place(fixture(),{x:300,y:220},'6');assert(reverse.points.slice(1).every(p=>p.x<300));
const dragged=place(fixture(),{x:364,y:220},'6',{x:364,y:120});assert(dragged.valid);assert(dragged.points.slice(1).every(p=>p.y<220));
const blocked=fixture(),bad=place(blocked,{x:364,y:220},'6',{x:250,y:220}),snapshot=JSON.stringify(blocked);assert(!bad.valid);assert(!add(blocked,bad,'6'));assert.equal(JSON.stringify(blocked),snapshot);
const edge=fixture();edge.atoms=[{x:820,y:220,label:'C'},{x:884,y:220,label:'C'}];const edgePlan=place(edge,edge.atoms[1],'6');assert(edgePlan.valid);assert(edgePlan.points.every(p=>p.x<=952&&p.y>=8&&p.y<=432));
const empty={width:960,height:440,atoms:[],bonds:[],marks:[]};assert(add(empty,place(empty,{x:10,y:10},'5'),'5'));assert.equal(empty.atoms.length,5);
assert.equal(nearest({atoms:[{x:0,y:0},{x:15,y:0}]},{x:14,y:0}),1,'choose closest, not first');
const labeled=fixture();labeled.atoms[1].label='N';add(labeled,place(labeled,labeled.atoms[1],'6'),'6');assert.equal(labeled.atoms[1].label,'N');
console.log('Passed: connected 5/6/benzene rings, shared anchor, nearest snap, outward orientation, drag direction, bounds, overlap refusal, standalone ring and label preservation.');
