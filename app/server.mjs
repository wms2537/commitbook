import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {projectRoot} from '../scripts/compile.mjs';

const ACTIONS = new Map([
  ['/api/plan','plan'], ['/api/execute','execute'], ['/api/recover','recover'],
  ['/api/cancel','cancel'], ['/api/retry','retry'], ['/api/late-grant','lateGrant'],
  ['/api/finalize','finalize'], ['/api/reset','reset'],
]);
const STATIC_FILES = new Map([
  ['/','index.html'], ['/index.html','index.html'], ['/app.css','app.css'], ['/app.js','app.js'],
]);
const MIME = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'};
const LIMIT = 16 * 1024;

function fail(code, message, status = 400) {
  return Object.assign(new Error(message), {code, status, expose:true});
}

function publicError(error) {
  const controlled = error?.expose === true || error?.name === 'RuntimeError';
  const safe = controlled && typeof error?.code === 'string' && /^[A-Z0-9_]{2,64}$/.test(error.code);
  return {error:{code:safe?error.code:'APPLICATION_ERROR', message:safe?String(error.message).slice(0,400):'The operation could not be completed.'}};
}

function json(response, status, data) {
  response.writeHead(status, {'content-type':'application/json; charset=utf-8'});
  response.end(JSON.stringify(data));
}

async function body(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type']??'')) {
    throw fail('JSON_REQUIRED','Send an application/json request.',415);
  }
  if (Number(request.headers['content-length']??0)>LIMIT) throw fail('BODY_TOO_LARGE','Request exceeds 16 KiB.',413);
  const chunks=[];
  let size=0;
  for await (const chunk of request) {
    size+=chunk.length;
    if(size>LIMIT) throw fail('BODY_TOO_LARGE','Request exceeds 16 KiB.',413);
    chunks.push(chunk);
  }
  let parsed;
  try { parsed=JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail('INVALID_JSON','The request body is not valid JSON.'); }
  if (!parsed || typeof parsed!=='object' || Array.isArray(parsed)) throw fail('INVALID_BODY','A JSON object is required.');
  return parsed;
}

/** Local-only application boundary. It never opens the public testnet wallet. */
export function createApplication({runtime, scenario, publicDirectory=path.join(projectRoot,'app/public'), trustedOrigin=()=>null, stopPlanner=()=>{}}) {
  let scenarioActive=false;
  let scenarioStep=null;
  const view=()=>({...runtime.snapshot(),busy:scenarioActive||runtime.snapshot().busy,scenario:scenarioActive?{active:true,step:scenarioStep}:null});
  const server=http.createServer(async(request,response)=>{
    response.setHeader('cache-control','no-store');
    response.setHeader('x-content-type-options','nosniff');
    response.setHeader('referrer-policy','no-referrer');
    response.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const port=server.address()?.port;
      const origins=new Set([`http://127.0.0.1:${port}`,`http://localhost:${port}`,`http://[::1]:${port}`]);
      const explicit=trustedOrigin();
      if(explicit){
        const configured=new URL(explicit);
        if(!['http:','https:'].includes(configured.protocol)||configured.pathname!=='/'||configured.search||configured.hash||configured.username||configured.password) {
          throw fail('INVALID_PREVIEW_ORIGIN','Preview origin configuration is invalid.',500);
        }
        origins.add(configured.origin);
      }
      const allowedHosts=new Set([...origins].map(origin=>new URL(origin).host));
      if(!allowedHosts.has(request.headers.host)) throw fail('HOST_REJECTED','This server accepts only its configured host.',403);
      if(request.headers.origin&&!origins.has(request.headers.origin)) throw fail('ORIGIN_REJECTED','Cross-origin application requests are not allowed.',403);
      if(request.method!=='GET'&&request.method!=='HEAD'&&request.headers['sec-fetch-site']==='cross-site') {
        throw fail('CROSS_SITE_REJECTED','Cross-site mutations are not allowed.',403);
      }
      const url=new URL(request.url,'http://localhost');
      if(request.method==='GET'&&url.pathname==='/api/state') return json(response,200,view());
      if(request.method==='GET'&&url.pathname==='/api/evidence') {
        response.setHeader('content-disposition','attachment; filename="commitbook-session-evidence.json"');
        return json(response,200,{...(runtime.evidence?.()??{state:view()}),exportedAt:new Date().toISOString(),publicTestnetExecution:false});
      }
      if(request.method==='POST'&&(ACTIONS.has(url.pathname)||url.pathname==='/api/scenario')) {
        const input=await body(request);
        if(scenarioActive) throw fail('RUNTIME_BUSY','The recovery demo is running. Wait for its next result.',409);
        if(typeof input.sessionId!=='string'||input.sessionId!==runtime.snapshot().sessionId) throw fail('STALE_SESSION','This page belongs to an older session. Refresh its state.',409);
        if(url.pathname==='/api/scenario') {
          if(!scenario) throw fail('SCENARIO_UNAVAILABLE','The recovery demo is unavailable.',503);
          scenarioActive=true;
          try {
            const result=await scenario(runtime,input,{onStep:step=>{scenarioStep=step;}});
            return json(response,200,{state:runtime.snapshot(),result});
          } finally {scenarioActive=false;scenarioStep=null;}
        }
        const result=await runtime[ACTIONS.get(url.pathname)](input);
        return json(response,200,{state:runtime.snapshot(),result:result?.result??null});
      }
      if((request.method==='GET'||request.method==='HEAD')&&STATIC_FILES.has(url.pathname)) {
        const file=path.join(publicDirectory,STATIC_FILES.get(url.pathname));
        if(!fs.existsSync(file)) throw fail('UI_NOT_BUILT','The interface files are unavailable.',503);
        response.writeHead(200,{'content-type':MIME[path.extname(file)]});
        return request.method==='HEAD'?response.end():fs.createReadStream(file).pipe(response);
      }
      throw fail('NOT_FOUND','This route does not exist.',404);
    } catch(error) {
      if(response.headersSent){response.end();return;}
      const status=Number(error.statusCode??error.status);
      json(response,Number.isInteger(status)&&status>=400&&status<600?status:500,publicError(error));
    }
  });
  server.requestTimeout=30_000;
  server.headersTimeout=15_000;
  server.keepAliveTimeout=5_000;
  return {
    server,
    async listen({port=0,host='127.0.0.1'}={}){
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.off('error',reject);resolve();});});
      return `http://${host==='0.0.0.0'?'127.0.0.1':host}:${server.address().port}`;
    },
    async close(){
      const closed=new Promise(resolve=>server.close(resolve));
      await stopPlanner();
      const deadline=Date.now()+5000;
      while(runtime.snapshot().busy&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
      server.closeAllConnections();await closed;await runtime.close?.();
    },
  };
}

async function main(){
  const {createRuntime}=await import('./runtime.mjs');
  const {closeModel}=await import('../agent/planner.mjs');
  const {runRecoveryScenario}=await import('./scenario.mjs');
  const externalModel=Boolean(process.env.COMMITBOOK_LLM_URL);
  const localModelInstalled=fs.existsSync(path.join(projectRoot,'.runtime/model-venv/bin/python'))
    &&fs.existsSync(path.join(projectRoot,'.models/qwen2.5-1.5b-instruct-q4_k_m.gguf'));
  const runtime=await createRuntime({modelStatus:{
    provider:externalModel?'configured-compatible-provider':'local-llama.cpp-stdio',
    model:process.env.COMMITBOOK_LLM_MODEL||'commitbook-qwen2.5-1.5b',
    ready:false,status:externalModel||localModelInstalled?'ready-to-load':'setup-required',
  }});
  const originFile=path.join(projectRoot,'.runtime/preview-origin.json');
  const app=createApplication({runtime,scenario:runRecoveryScenario,stopPlanner:closeModel,trustedOrigin:()=>{
    if(process.env.COMMITBOOK_PREVIEW_ORIGIN)return process.env.COMMITBOOK_PREVIEW_ORIGIN;
    return fs.existsSync(originFile)?JSON.parse(fs.readFileSync(originFile,'utf8')).origin:null;
  }});
  const host=process.env.HOST==='0.0.0.0'?'0.0.0.0':'127.0.0.1';
  const port=Number(process.env.PORT??4173);
  if(!Number.isInteger(port)||port<1||port>65535)throw fail('INVALID_PORT','Choose an integer port from 1 to 65535.');
  const url=await app.listen({host,port});
  console.log(JSON.stringify({application:'CommitBook',url,mode:'local-evm',publicTestnetExecution:false}));
  const stop=()=>{app.close().then(()=>process.exit(0),()=>process.exit(1));};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  main().catch(error=>{console.error(JSON.stringify(publicError(error)));process.exitCode=1;});
}
