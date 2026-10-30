import { fork } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { openDatabase, migrateDatabase, closeDatabase, withTransaction } from '../../../apps/api/src/db/index.js';
import { routeJourney } from '../../../apps/api/src/journey.js';

if (process.argv[2] === '--child') {
  const n = Number(process.argv[3]);
  const db = openDatabase(':memory:');
  migrateDatabase(db);
  const now = '2026-10-30T12:00:00.000Z';
  const restaurant = db.prepare("INSERT INTO restaurants(id,name,status,created_at,always_open,cuisine) VALUES(?,?,'approved',?,1,'Synthetic')");
  const item = db.prepare('INSERT INTO menu_items(id,restaurant_id,name,description,price_minor,available,created_at,updated_at,category) VALUES(?,?,?,?,1200,1,?,?,?)');
  withTransaction(db, () => {
    for(let i=0;i<n;i++) {
      restaurant.run(`r-${i}`, `Synthetic restaurant ${i}`, now);
      for(let j=0;j<20;j++) item.run(`m-${i}-${j}`,`r-${i}`,`Dish ${j}`,'Fictional audit data',now,now,'Mains');
    }
  });
  process.send({type:'ready', restaurants:n, menuItems:n*20});
  const samples=[];
  for(let i=0;i<(n===10000?1:3);i++) {
    let bytes=0, count=0;
    const res={setHeader(){},writeHead(){},end(body){bytes=Buffer.byteLength(body);count=JSON.parse(body).data.length;}};
    const t=performance.now();
    await routeJourney({req:{method:'GET'},res,url:new URL('http://127.0.0.1/api/restaurants'),db,config:{now:()=>new Date(now)},session:null});
    samples.push({ms:Math.round((performance.now()-t)*100)/100,bytes,count});
  }
  process.send({type:'result',restaurants:n,menuItems:n*20,samples});
  closeDatabase(db);
  process.disconnect();
} else {
  const results=[];
  for(const n of [100,1000,10000]) {
    const result=await new Promise(resolve=>{
      const child=fork(new URL(import.meta.url),['--child',String(n)],{stdio:['ignore','ignore','ignore','ipc']});
      let settled=false, timer;
      const done=row=>{if(settled)return;settled=true;clearTimeout(timer);resolve(row);};
      timer=setTimeout(()=>{child.kill();done({restaurants:n,status:'setup_timeout',timeoutMs:30000});},30000);
      child.on('message',message=>{
        if(message.type==='ready') {clearTimeout(timer); timer=setTimeout(()=>{child.kill();done({restaurants:n,menuItems:n*20,status:'route_timeout',timeoutMs:30000});},30000);}
        if(message.type==='result')done({...message,status:'completed'});
      });
      child.once('error',error=>done({restaurants:n,status:'error',error:error.message}));
      child.once('exit',code=>{if(!settled)done({restaurants:n,status:'exit_without_result',code});});
    });
    results.push(result);
    console.log(JSON.stringify(result));
  }
  const report={date:'2026-10-30',commit:'b94092ee4657b01d93466a4ddf282155f76a0fa2',node:process.version,sqlite:process.versions.sqlite,platform:process.platform,cpu:os.cpus()[0]?.model,memoryGiB:Math.round(os.totalmem()/1024**3),method:'Actual routeJourney GET /api/restaurants on freshly migrated in-memory database, 20 menu items per restaurant, zero orders, one request at a time; no HTTP transport, auth, remote provider or production data; 30s per child route budget.',results,limitations:['Single synthetic host and tiny menus; these are route samples, not a capacity/SLO benchmark.','In-memory SQLite excludes disk contention and order history.','No claimed p95/p99 from this small sample.','Independent agents and audit checks may consume host resources; rerun on controlled staging hardware for sizing.']};
  writeFileSync(new URL('./discovery-results.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
}
