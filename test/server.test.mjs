import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createApplication} from '../app/server.mjs';

async function fixture(t,options={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'commitbook-http-'));
  fs.writeFileSync(path.join(directory,'index.html'),'<!doctype html><title>CommitBook test</title>');
  const calls=[];
  const state={sessionId:'session-123',busy:false,mode:'local-evm',budget:{cap:100,spent:0,reserved:0,available:100}};
  const runtime={snapshot:()=>structuredClone(state),evidence:()=>({state,publicTestnetExecution:false}),
    async plan(input){calls.push(input);return{...state,result:{planId:'plan-1'}};}};
  const app=createApplication({runtime,publicDirectory:directory,...options});
  const url=await app.listen();
  t.after(async()=>{await app.close();fs.rmSync(directory,{recursive:true,force:true});});
  return{app,url,calls,state};
}
const post=(url,body,headers={})=>fetch(url+'/api/plan',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});

test('HTTP mutation reaches the runtime only with the current session and returns actual state',async t=>{
  const f=await fixture(t);
  const response=await post(f.url,{sessionId:'session-123',goal:'Extract privately.'});
  assert.equal(response.status,200);
  assert.equal((await response.json()).result.planId,'plan-1');
  assert.equal(f.calls.length,1);
  const stale=await post(f.url,{sessionId:'old-session',goal:'Extract.'});
  assert.equal(stale.status,409);assert.equal(f.calls.length,1);
});

test('foreign Origin, rebinding Host, and cross-site mutations cannot reach runtime',async t=>{
  const f=await fixture(t);
  for(const headers of[{origin:'https://other.example'},{host:'attacker.example'},{'sec-fetch-site':'cross-site'}]){
    // Native HTTP preserves the deliberately hostile Host/Fetch-Metadata fields.
    const status=await new Promise((resolve,reject)=>{
      const req=http.request(f.url+'/api/plan',{method:'POST',headers:{'content-type':'application/json',...headers}},res=>{res.resume();resolve(res.statusCode);});
      req.on('error',reject);req.end(JSON.stringify({sessionId:'session-123'}));
    });
    assert.equal(status,403,JSON.stringify(headers));
  }
  assert.equal(f.calls.length,0);
});

test('HTTP input boundary rejects non-JSON, malformed JSON, arrays, and oversized bodies',async t=>{
  const f=await fixture(t);
  for(const [payload,type,expected]of[['x','text/plain',415],['{','application/json',400],['[]','application/json',400],[JSON.stringify({sessionId:'session-123',goal:'x'.repeat(17000)}),'application/json',413]]){
    const response=await fetch(f.url+'/api/plan',{method:'POST',headers:{'content-type':type},body:payload});
    assert.equal(response.status,expected);
  }
  assert.equal(f.calls.length,0);
});

test('static allowlist prevents source or wallet downloads and applies browser security headers',async t=>{
  const f=await fixture(t);
  for(const route of['/.secrets/testnet-wallet.json','/app/server.mjs','/../package.json']){
    assert.equal((await fetch(f.url+route)).status,404);
  }
  const page=await fetch(f.url);
  assert.match(page.headers.get('content-security-policy'),/script-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'),'nosniff');
  assert.match(await page.text(),/CommitBook test/);
});

test('the scenario blocks overlapping mutations while state remains readable',async t=>{
  let release;
  const started=new Promise(resolve=>{release=resolve;});
  let enter;
  const entered=new Promise(resolve=>{enter=resolve;});
  const f=await fixture(t,{scenario:async()=>{enter();await started;return{verified:true};}});
  const pending=fetch(f.url+'/api/scenario',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:'session-123'})});
  await entered;
  assert.equal((await(await fetch(f.url+'/api/state')).json()).busy,true);
  assert.equal((await post(f.url,{sessionId:'session-123'})).status,409);
  release();assert.equal((await pending).status,200);
  assert.equal(f.calls.length,0);
});

test('evidence export keeps local execution explicit and coded provider failures do not expose secrets',async t=>{
  const f=await fixture(t,{scenario:async()=>{throw Object.assign(new Error('secret-provider-url-and-key'),{code:'NETWORK_ERROR'});}});
  const evidence=await(await fetch(f.url+'/api/evidence')).json();
  assert.equal(evidence.publicTestnetExecution,false);
  const response=await fetch(f.url+'/api/scenario',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:'session-123'})});
  assert.equal(response.status,500);
  assert.doesNotMatch(await response.text(),/secret-provider/);
});

test('shutdown stops the planner and waits for active mutation cleanup before closing the runtime',async t=>{
  const state={sessionId:'closing-session',busy:false,mode:'local-evm'};
  let started,stopModel,cleaned=false,closed=false,stopCalls=0;
  const entered=new Promise(resolve=>{started=resolve;});
  const pendingModel=new Promise((resolve,reject)=>{stopModel=reject;});
  const runtime={
    snapshot:()=>structuredClone(state),
    async plan(){
      state.busy=true;started();
      try {await pendingModel;}
      finally {
        // Contract state refresh and action cleanup can outlive model abortion.
        await new Promise(resolve=>setTimeout(resolve,40));
        cleaned=true;state.busy=false;
      }
    },
    async close(){assert.equal(state.busy,false);assert.equal(cleaned,true);closed=true;},
  };
  const app=createApplication({runtime,stopPlanner:()=>{stopCalls++;stopModel(new Error('Model stopped'));}});
  t.after(async()=>{if(app.server.listening)await app.close();});
  const url=await app.listen();
  const response=post(url,{sessionId:state.sessionId,goal:'A request still running.'});
  await entered;
  await app.close();
  assert.equal((await response).status,500);
  assert.equal(stopCalls,1);assert.equal(cleaned,true);assert.equal(closed,true);
});
