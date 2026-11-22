import crypto from "node:crypto";
import http from "node:http";
import {API_ORIGIN,BROKER_PORT,failure} from "./protocol.js";
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const equal=(a,b)=>typeof a==="string"&&TOKEN.test(a)&&TOKEN.test(b)&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
function reply(response,status,value){
  response.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","content-security-policy":"default-src 'none'; frame-ancestors 'none'"});
  response.end(JSON.stringify(value));
}
async function readBody(request){
  if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"]||""))throw failure("TABLET_JSON_REQUIRED");
  let size=0;const chunks=[];
  for await(const chunk of request){size+=chunk.length;if(size>32768)throw failure("TABLET_BODY_TOO_LARGE",413);chunks.push(chunk);}
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw failure("TABLET_JSON_INVALID");}
  if(!body||typeof body!=="object"||Array.isArray(body))throw failure("TABLET_JSON_INVALID");
  return body;
}
export function createBrokerServer({device,origin=API_ORIGIN,port=BROKER_PORT,csrfToken=crypto.randomBytes(32).toString("base64url"),clock=Date.now,requestLimit=180}){
  if(origin!==API_ORIGIN&&!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))throw Error("Broker origin is not approved");
  if(!TOKEN.test(csrfToken))throw Error("Broker process token is invalid");
  let windowStart=clock(),requests=0,pending=0;
  let server;
  const handle=async(request,response)=>{
    const actualPort=server.address()?.port??port;
    if(request.headers.host!=="127.0.0.1:"+actualPort||request.headers.origin!==origin||!["127.0.0.1","::ffff:127.0.0.1"].includes(request.socket.remoteAddress))return reply(response,403,{error:{code:"TABLET_LOCAL_ORIGIN_DENIED",message:"Open the restaurant tablet app."}});
    response.setHeader("Access-Control-Allow-Origin",origin);response.setHeader("Vary","Origin");
    if(clock()-windowStart>=60000){windowStart=clock();requests=0;}
    if(++requests>requestLimit)return reply(response,429,{error:{code:"TABLET_LOCAL_RATE_LIMIT",message:"The tablet is reconnecting. Please wait."}});
    if(request.method==="OPTIONS"){
      const headers=(request.headers["access-control-request-headers"]||"").toLowerCase().split(",").map(s=>s.trim()).filter(Boolean);
      if(!["GET","POST"].includes(request.headers["access-control-request-method"])||headers.some(h=>!["content-type","x-calai-terminal-csrf","x-calai-terminal-window"].includes(h)))return reply(response,403,{error:{code:"TABLET_LOCAL_PREFLIGHT_DENIED"}});
      response.setHeader("Access-Control-Allow-Methods","GET, POST");response.setHeader("Access-Control-Allow-Headers","Content-Type, X-Calai-Terminal-CSRF, X-Calai-Terminal-Window");
      if(request.headers["access-control-request-private-network"]==="true")response.setHeader("Access-Control-Allow-Private-Network","true");
      response.writeHead(204);return response.end();
    }
    if(request.method==="GET"&&request.url==="/v1/bootstrap")return reply(response,200,{data:{product:"calai-business-terminal",version:"1.0.0",...device.bootstrap(),csrfToken}});
    if(request.method!=="POST"||!equal(request.headers["x-calai-terminal-csrf"],csrfToken))return reply(response,403,{error:{code:"TABLET_LOCAL_CSRF_REQUIRED",message:"Reconnect this restaurant tablet."}});
    if(!["/v1/enrol","/v1/automatic-session","/v1/request"].includes(request.url))return reply(response,404,{error:{code:"TABLET_LOCAL_ROUTE_NOT_FOUND"}});
    if(pending>=4)return reply(response,429,{error:{code:"TABLET_LOCAL_BUSY"}});
    pending++;
    try{
      const body=await readBody(request);
      const result=request.url==="/v1/enrol"?await device.enrol(body):request.url==="/v1/automatic-session"?await device.automaticSession(body):await device.forward(body,{windowProof:request.headers["x-calai-terminal-window"]});
      reply(response,200,{data:result});
    }finally{pending--;}
  };
  server=http.createServer((request,response)=>{void handle(request,response).catch(error=>{
    if(response.headersSent){response.destroy();return;}
    const status=[400,401,403,404,409,413,422,429,503].includes(error.status)?error.status:503;
    const code=/^[A-Z][A-Z0-9_]{2,80}$/.test(error.code||"")?error.code:"TABLET_BROKER_UNAVAILABLE";
    reply(response,status,{error:{code,message:"The restaurant tablet connection needs attention."}});
  });});
  server.headersTimeout=10000;server.requestTimeout=15000;server.keepAliveTimeout=2000;server.maxConnections=16;
  return server;
}
export async function startBroker(options){
  const server=createBrokerServer(options);
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(options.port??BROKER_PORT,"127.0.0.1",resolve);});
  const stop=()=>{server.close();server.closeAllConnections();options.device.close();};
  options.signal?.addEventListener("abort",stop,{once:true});
  if(options.signal?.aborted)stop();
  return {server,stop};
}
