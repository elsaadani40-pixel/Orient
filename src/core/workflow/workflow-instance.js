const crypto = require('crypto');
const AppError = require('../errors/AppError');
const WorkflowDefinition = require('./workflow-definition');

const STATES=Object.freeze({ CREATED:'CREATED', QUEUED:'QUEUED', RUNNING:'RUNNING', WAITING:'WAITING', COMPLETED:'COMPLETED', FAILED:'FAILED', CANCELLED:'CANCELLED', RECOVERING:'RECOVERING' });

class WorkflowInstance {
  constructor({ definition, workflowId=crypto.randomUUID(), tenantId='local', input={}, now=()=>new Date() }) {
    if (!(definition instanceof WorkflowDefinition)) throw new AppError('Workflow definition required',400,'WORKFLOW_DEFINITION_REQUIRED');
    this.workflowId=workflowId; this.tenantId=tenantId; this.definitionId=definition.id; this.definitionVersion=definition.version; this.input=structuredClone(input); this.state=STATES.CREATED; this.createdAt=now().toISOString(); this.updatedAt=this.createdAt; this.steps=Object.fromEntries(definition.steps.map(s=>[s.id,{state:WorkflowDefinition.STEP_STATES.PENDING,attempts:0,result:null,error:null}])); this.metadata={};
  }
  transition(next,now=()=>new Date()){ const allowed={CREATED:['QUEUED','CANCELLED'],QUEUED:['RUNNING','CANCELLED'],RUNNING:['WAITING','COMPLETED','FAILED','CANCELLED','RECOVERING'],WAITING:['RUNNING','CANCELLED'],RECOVERING:['RUNNING','FAILED','CANCELLED'],COMPLETED:[],FAILED:[],CANCELLED:[]}; if(!allowed[this.state]?.includes(next)) throw new AppError(`Invalid workflow transition ${this.state} -> ${next}`,409,'WORKFLOW_INVALID_TRANSITION'); this.state=next; this.updatedAt=now().toISOString(); return this; }
  readySteps(){ return this.definition.steps.filter(s=>this.steps[s.id].state===WorkflowDefinition.STEP_STATES.PENDING && s.dependsOn.every(d=>this.steps[d].state===WorkflowDefinition.STEP_STATES.COMPLETED)); }
  markStepRunning(id){this.steps[id].state=WorkflowDefinition.STEP_STATES.RUNNING;this.steps[id].attempts+=1;}
  markStepCompleted(id,result){this.steps[id].state=WorkflowDefinition.STEP_STATES.COMPLETED;this.steps[id].result=result;this.steps[id].error=null;}
  markStepFailed(id,error){this.steps[id].state=WorkflowDefinition.STEP_STATES.FAILED;this.steps[id].error={message:error?.message||String(error),code:error?.code||'WORKFLOW_STEP_FAILED'};}
  cancelStep(id){if(this.steps[id]?.state!==WorkflowDefinition.STEP_STATES.COMPLETED)this.steps[id].state=WorkflowDefinition.STEP_STATES.CANCELLED;}
  toJSON(){return {workflowId:this.workflowId,tenantId:this.tenantId,definitionId:this.definitionId,definitionVersion:this.definitionVersion,input:this.input,state:this.state,createdAt:this.createdAt,updatedAt:this.updatedAt,steps:this.steps,metadata:this.metadata};}
}
WorkflowInstance.STATES=STATES; module.exports=WorkflowInstance;