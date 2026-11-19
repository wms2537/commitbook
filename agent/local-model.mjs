import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let worker=null,serial=Promise.resolve(),sequence=0;
const failure=code=>Object.assign(new Error(code),{code});

function startWorker() {
  if(worker)return worker;
  const python=path.join(root,'.runtime/model-venv/bin/python');
  if(!fs.existsSync(python)||!fs.existsSync(path.join(root,'.models/qwen2.5-1.5b-instruct-q4_k_m.gguf')))throw failure('MODEL_SETUP_REQUIRED');
  const child=spawn(python,['-u',path.join(root,'scripts/model-worker.py')],{cwd:root,stdio:['pipe','pipe','pipe']});
  const record={child,pending:null,buffer:'',ready:false};
  record.readyPromise=new Promise((resolve,reject)=>{record.resolveReady=resolve;record.rejectReady=reject;});
  worker=record;
  const rejectAll=code=>{
    const error=failure(code);record.rejectReady(error);record.pending?.reject(error);record.pending=null;
    if(worker===record)worker=null;
  };
  child.on('error',()=>rejectAll('MODEL_WORKER_UNAVAILABLE'));
  child.on('exit',()=>rejectAll('MODEL_WORKER_EXITED'));
  child.stdin.on('error',()=>rejectAll('MODEL_WORKER_EXITED'));
  // Native inference diagnostics never enter protocol output or application logs.
  child.stderr.on('data',()=>{});
  child.stdout.on('data',chunk=>{
    record.buffer+=chunk.toString('utf8');
    if(record.buffer.length>128_000){rejectAll('MODEL_RESPONSE_TOO_LARGE');child.kill();return;}
    for(let boundary;(boundary=record.buffer.indexOf('\n'))>=0;) {
      const line=record.buffer.slice(0,boundary);record.buffer=record.buffer.slice(boundary+1);
      if(!line.trim())continue;
      let message;
      try {message=JSON.parse(line);} catch {rejectAll('MODEL_WORKER_PROTOCOL');child.kill();return;}
      if(message.ready===true){record.ready=true;record.resolveReady();continue;}
      if(message.startupError){rejectAll('MODEL_WORKER_STARTUP_FAILED');child.kill();return;}
      if(!record.pending||message.id!==record.pending.id){rejectAll('MODEL_WORKER_PROTOCOL');child.kill();return;}
      const pending=record.pending;record.pending=null;
      if(message.error)pending.reject(failure('MODEL_INFERENCE_FAILED'));
      else pending.resolve(message.response);
    }
  });
  return record;
}

export function closeLocalModel() {
  if(!worker)return;
  const current=worker;worker=null;
  current.rejectReady(failure('MODEL_WORKER_STOPPED'));
  current.pending?.reject(failure('MODEL_WORKER_STOPPED'));current.pending=null;
  current.child.kill('SIGTERM');
}

export function localCompletion(body,{timeoutMs=60_000}={}) {
  const deadline=Date.now()+Math.max(1,Math.min(timeoutMs,60_000));
  const job=serial.then(async()=>{
    const remaining=deadline-Date.now();
    if(remaining<=0)throw failure('MODEL_TIMEOUT');
    const current=startWorker();
    let timer;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{reject(failure('MODEL_TIMEOUT'));closeLocalModel();},remaining);});
    const execute=async()=>{
      await current.readyPromise;
      const id=++sequence;
      return await new Promise((resolve,reject)=>{
        current.pending={id,resolve,reject};
        current.child.stdin.write(JSON.stringify({id,body})+'\n');
      });
    };
    try {return await Promise.race([execute(),timeout]);}
    finally {clearTimeout(timer);}
  });
  serial=job.catch(()=>{});
  return job;
}
