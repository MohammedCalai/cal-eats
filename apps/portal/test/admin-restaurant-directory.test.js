import assert from "node:assert/strict";
import test from "node:test";
import {Readable} from "node:stream";
import {restaurantDirectoryState,restaurantDirectoryQuery,restaurantDirectoryParams,restaurantResultPages,restaurantDirectoryStatus} from "../src/admin-restaurant-directory.js";
import {journeyFixture} from "../../api/test/helpers.js";
import {routeAdminRestaurantWorkspace} from "../../api/src/admin-restaurant-workspace.js";

test("directory requests stay bounded and preserve search and page when opening a restaurant",()=>{
  const current=new URLSearchParams({q:"Curry & Rice",status:"pending",page:"3"});
  const query=new URLSearchParams(restaurantDirectoryQuery(restaurantDirectoryState(current)));
  assert.equal(query.get("q"),"Curry & Rice");assert.equal(query.get("status"),"pending");assert.equal(query.get("page"),"3");assert.equal(query.get("pageSize"),"25");
  const opened=restaurantDirectoryParams(current,{restaurant:"restaurant-one",section:"marketing"});
  assert.equal(opened.get("q"),"Curry & Rice");assert.equal(opened.get("status"),"pending");assert.equal(opened.get("page"),"3");assert.equal(opened.get("restaurant"),"restaurant-one");
  const returned=restaurantDirectoryParams(opened,{restaurant:"",section:""});assert.equal(returned.toString(),current.toString());
  const searched=restaurantDirectoryParams(returned,{q:"Luton",page:1});assert.equal(searched.get("page"),null);assert.equal(searched.get("q"),"Luton");assert.equal(searched.get("status"),"pending");
  assert.deepEqual(restaurantDirectoryState(new URLSearchParams({page:"-1",status:"made-up"})),{search:"",status:"all",page:1});
});

test("numbered pages remain compact for 450 restaurants and very large directories",()=>{
  assert.deepEqual(restaurantResultPages(1,18),[1,2,3,4,"gap",18]);
  assert.deepEqual(restaurantResultPages(9,18),[1,"gap",8,9,10,"gap",18]);
  assert.deepEqual(restaurantResultPages(18,18),[1,"gap",15,16,17,18]);
  assert.deepEqual(restaurantResultPages(2,3),[1,2,3]);assert.deepEqual(restaurantResultPages(1,0),[]);
  const large=restaurantResultPages(50000,100000);assert.ok(large.length<=7);assert.ok(large.includes(50000));assert.equal(large[0],1);assert.equal(large.at(-1),100000);
});

test("directory status distinguishes pending applications, approval and suspension",()=>{
  assert.deepEqual(restaurantDirectoryStatus({status:"pending"}),{label:"Pending application",tone:"pending"});
  assert.equal(restaurantDirectoryStatus({status:"approved"}).label,"Approved");
  assert.equal(restaurantDirectoryStatus({status:"approved",suspended:true}).label,"Suspended");
  assert.equal(restaurantDirectoryStatus({status:"rejected"}).label,"Not approved");
  assert.equal(restaurantDirectoryStatus({status:"approved",archivedAt:"2030-01-01"}).label,"Archived");
  assert.equal(restaurantDirectoryStatus({status:"unknown"}).label,"Status unavailable");
});

test("the existing directory API serves 450 restaurants in 25-row pages with working filters",async()=>{
  const f=await journeyFixture({now:()=>new Date("2030-01-01T10:00:00.000Z")});
  try{
    const session={user:f.db.prepare("SELECT id,name,email,role FROM users WHERE role='admin'").get()},now=f.config.now().toISOString();
    f.db.prepare("UPDATE restaurants SET archived_at=?").run(now);
    const insert=f.db.prepare("INSERT INTO restaurants(id,name,status,address,cuisine,suspended,created_at) VALUES(?,?,?,?,?,?,?)");
    f.db.exec("BEGIN");
    try{for(let index=1;index<=450;index++)insert.run(`directory-local-${index}`,`Restaurant ${String(index).padStart(3,"0")}`,index<=30?"pending":index<=40?"rejected":"approved",`${index} Test Street, Luton, LU1 1AA`,"Local fixture",index>440?1:0,now);f.db.exec("COMMIT");}catch(error){f.db.exec("ROLLBACK");throw error;}
    async function read(options){
      const path=`/api/admin/restaurant-directory?${restaurantDirectoryQuery(options)}`,req=Readable.from([]);
      Object.assign(req,{method:"GET",url:path,headers:{},socket:{remoteAddress:"127.0.0.1"}});
      const res={statusCode:200,setHeader(){},writeHead(status){this.statusCode=status;},end(value){this.body=JSON.parse(String(value));}};
      await routeAdminRestaurantWorkspace({req,res,url:new URL(path,"http://localhost"),db:f.db,config:f.config,session});
      assert.equal(res.statusCode,200);return res.body.data;
    }
    const first=await read({page:1}),last=await read({page:18});
    assert.equal(first.pagination.total,450);assert.equal(first.pagination.totalPages,18);assert.equal(first.pagination.pageSize,25);assert.equal(first.items.length,25);assert.equal(last.items.length,25);
    assert.equal(first.items[0].name,"Restaurant 001");assert.equal(last.items.at(-1).name,"Restaurant 450");
    assert.equal(first.pagination.hasPrevious,false);assert.equal(last.pagination.hasNext,false);assert.ok(first.items.every(row=>!last.items.some(end=>end.id===row.id)));
    const pending=await read({status:"pending",page:2});assert.equal(pending.pagination.total,30);assert.equal(pending.items.length,5);assert.ok(pending.items.every(row=>row.status==="pending"));
    const suspended=await read({status:"suspended"});assert.equal(suspended.pagination.total,10);assert.ok(suspended.items.every(row=>row.suspended));
    const searched=await read({search:"Restaurant 450"});assert.equal(searched.pagination.total,1);assert.equal(searched.items[0].name,"Restaurant 450");
    const empty=await read({search:"No matching business"});assert.equal(empty.pagination.total,0);assert.equal(empty.items.length,0);
  }finally{await f.close();}
});
