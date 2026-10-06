const crypto = require('crypto');
const AppError = require('../errors/app-error');

const STEP_STATES = Object.freeze({ PENDING:'PENDING', READY:'READY', RUNNING:'RUNNING', COMPLETED:'COMPLETED', FAILED:'FAILED', BLOCKED:'BLOCKED', CANCELLED:'CANCELLED' });

class WorkflowDefinition {
  constructor({ id, version=1, name, steps }) {
    if (!id || !name || !Array.isArray(steps) || steps.length === 0) throw new AppError('Invalid workflow definition',400,'WORKFLOW_INVALID_DEFINITION');
    const ids = new Set();
    this.id=id; this.version=version; this.name=name;
    this.steps=steps.map((s,index)=>{
      if (!s || !s.id || ids.has(s.id)) throw new AppError('Duplicate or invalid workflow step',400,'WORKFLOW_DUPLICATE_STEP');
      ids.add(s.id);
      const dependsOn=Array.isArray(s.dependsOn)?[...s.dependsOn]:[];
      if (dependsOn.includes(s.id) || dependsOn.some(d=>!steps.some(x=>x&&x.id===d))) throw new AppError('Invalid workflow dependency',400,'WORKFLOW_INVALID_DEPENDENCY');
      return Object.freeze({ id:s.id, index, tool:s.tool||null, agent:s.agent||null, input:s.input??{}, dependsOn, timeoutMs:s.timeoutMs??null, metadata:Object.freeze({...s.metadata}) });
    });
    this.#assertAcyclic(); Object.freeze(this.steps); Object.freeze(this);
  }
  #assertAcyclic(){ const visiting=new Set(),visited=new Set(); const walk=id=>{ if(visiting.has(id)) throw new AppError('Workflow dependency cycle detected',400,'WORKFLOW_CYCLE'); if(visited.has(id)) return; visiting.add(id); const s=this.steps.find(x=>x.id===id); for(const d of s.dependsOn) walk(d); visiting.delete(id); visited.add(id); }; for(const s of this.steps) walk(s.id); }
  get key(){ return this.version+':'+this.id; }
  toJSON(){ return {id:this.id,version:this.version,name:this.name,steps:this.steps.map(s=>({...s}))}; }
}
WorkflowDefinition.STEP_STATES=STEP_STATES;
module.exports=WorkflowDefinition;