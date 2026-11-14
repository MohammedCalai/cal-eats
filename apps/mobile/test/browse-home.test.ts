import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

test("repeated Browse tabs request home without clearing the basket; pending checkout stays protected", () => {
  const source = ts.createSourceFile("App.tsx", fs.readFileSync(new URL("../App.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const handlers: ts.FunctionDeclaration[] = [];
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && ["selectTab","browseHome"].includes(node.name?.text || "")) handlers.push(node); ts.forEachChild(node, visit); }
  visit(source); assert.equal(handlers.length,2);
  const calls: string[] = []; let request = 0;
  const context = { checkout: false, checkoutBrowseAction:{current:null as null|(()=>void)},token: "customer", user: {}, pendingCheckout: { current: true }, pendingNotifications: { current: true },Keyboard:{dismiss(){}}, Alert: { alert() { calls.push("checkout-guard"); } },setCheckout(value:boolean){context.checkout=value;},setNotificationsOpen() {}, setBasketOpen() {}, setInboxRoute() {}, setTab() {}, setAuthOpen() {}, setFocusRestaurantId(value: unknown) { assert.equal(value, null); }, setBrowseHomeRequest(update: (n: number) => number) { request = update(request); }, resetHeader() { calls.push("top"); }, module: { exports: null as unknown } };
  vm.runInNewContext(ts.transpileModule(handlers.map(handler=>handler.getText(source)).join("\n") + ";module.exports={selectTab,browseHome}", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const {selectTab:select,browseHome:home} = context.module.exports as {selectTab:(tab:string)=>void;browseHome:()=>void};
  select("discover"); select("discover"); assert.equal(request, 2); assert.deepEqual(calls, ["top", "top"]);
  context.checkout = true; select("discover"); assert.equal(request, 2); assert.equal(calls.at(-1), "checkout-guard");
  context.checkoutBrowseAction.current=home;select("discover");assert.equal(request,3);assert.equal(context.checkout,false);
});

test("Browse resets categories and scroll identity while a stale menu response cannot reopen the restaurant or change its basket", async () => {
  const slots: any[] = [], cleanups: Array<undefined | (() => void)> = [], dependencies: any[][] = [];
  let cursor = 0, dirty = false, effects: Array<() => void> = [], resolveMenu: (value: unknown) => void = () => {};
  const api = () => new Promise(resolve => { resolveMenu = resolve; });
  const hooks = {
    useState(initial: any) { const slot = cursor++; if (!(slot in slots)) slots[slot] = typeof initial === "function" ? initial() : initial; return [slots[slot], (value: any) => { const next = typeof value === "function" ? value(slots[slot]) : value; if (!Object.is(next, slots[slot])) { slots[slot] = next; dirty = true; } }]; },
    useRef(initial: any) { const slot = cursor++; return slots[slot] ??= { current: initial }; },
    useEffect(callback: () => any, deps: any[]) { const slot = cursor++, previous = dependencies[slot]; if (!previous || deps.some((value, index) => !Object.is(value, previous[index]))) { dependencies[slot] = deps; effects.push(() => { cleanups[slot]?.(); cleanups[slot] = callback(); }); } },
    useLayoutEffect(callback: () => any, deps: any[]) { hooks.useEffect(callback, deps); }
  };
  const module = { exports: {} as any }, jsx = (type: unknown, props: any, key: unknown) => ({ type, props, key });
  const imports: Record<string, any> = { react: hooks, "react/jsx-runtime": { jsx, jsxs: jsx }, "react-native": { Alert: { alert() { throw Error("No replacement confirmation expected"); } } }, "expo-secure-store": {}, "./RestaurantMenu": { RestaurantMenu: "menu" }, "./DiscoveryBrowse": { DiscoveryBrowse: "home" }, "../api": { api }, "../model": { refreshCart: (cart: unknown) => cart } };
  const code = ts.transpileModule(fs.readFileSync(new URL("../src/screens/DiscoverScreen.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: (name: string) => { assert.ok(imports[name], name); return imports[name]; }, setTimeout: () => 1, clearTimeout() {}, URLSearchParams });
  const basket = [{ item: { id: "meal" }, quantity: 2 }], restaurant = { id: "saved", name: "Saved restaurant" }, offsets: number[] = [];
  const handled:number[]=[];
  const props: any = { userId: "customer", token: "customer", address: { postcode: "LU1 2BT" }, restaurant, cart: basket, fulfillment: "collection", browseHomeRequest: 0,browseHomePending:false,onBrowseHomeHandled(request:number){handled.push(request);props.browseHomePending=false;}, onCart() { throw Error("Browse must preserve the basket"); }, onRestaurant() { throw Error("Stale menu must not change the restaurant"); }, onScrollOffset(value: number) { offsets.push(value); } };
  function render() { let view: any; for (let pass = 0; pass < 12; pass++) { dirty = false; cursor = 0; effects = []; view = module.exports.DiscoverScreen(props); effects.forEach(effect => effect()); if (!dirty) return view; } throw Error("Hooks did not settle"); }
  assert.equal(render().type, "menu");
  props.browseHomeRequest = 1;props.browseHomePending=true; let view = render(); assert.equal(view.type, "home"); assert.equal(view.key, 1);
  view.props.onQuery("curry"); view.props.onFilters({ cuisine: "Indian", collection: "popular", offersOnly: true, sort: "quick" }); render();
  props.browseHomeRequest = 2;props.browseHomePending=true; view = render(); assert.equal(view.type, "home"); assert.equal(view.key, 2); assert.equal(view.props.query, ""); assert.equal(JSON.stringify(view.props.filters), JSON.stringify({ cuisine: "", offersOnly: false, sort: "recommended", collection: "home" }));assert.deepEqual(handled,[1,2]);
  resolveMenu({ restaurant: { id: "saved" }, items: [] }); await Promise.resolve(); await Promise.resolve();
  assert.equal(render().type, "home"); assert.equal(props.cart, basket); assert.equal(props.restaurant, restaurant); assert.equal(view.props.postcode, "LU1 2BT"); assert.equal(offsets.at(-1), 0);
});

test("checkout only permits Browse before submission and removes its action when closed",()=>{
  const source=ts.createSourceFile("CheckoutScreen.tsx",fs.readFileSync(new URL("../src/screens/CheckoutScreen.tsx",import.meta.url),"utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let callback:ts.Node|undefined;
  function visit(node:ts.Node){if(ts.isCallExpression(node)&&node.expression.getText(source)==="useLayoutEffect"&&node.arguments[0]?.getText(source).includes("onBrowseAction"))callback=node.arguments[0];ts.forEachChild(node,visit);}
  visit(source);assert.ok(callback);
  let action:(()=>void)|null=null,visits=0,blocked=0;
  const context={submitting:{current:false},attempt:{pending:null as unknown},claimingOffer:false,onBrowseAction(value:(()=>void)|null){action=value;},onBrowse(){visits++;},Alert:{alert(){blocked++;}},module:{exports:null as unknown}};
  vm.runInNewContext(ts.transpileModule(`module.exports=(${callback!.getText(source)})()`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  assert.equal(typeof action,"function");(action as unknown as ()=>void)();assert.equal(visits,1);
  context.submitting.current=true;(action as unknown as ()=>void)();context.submitting.current=false;context.attempt.pending={key:"unknown-order"};(action as unknown as ()=>void)();context.attempt.pending=null;context.claimingOffer=true;(action as unknown as ()=>void)();assert.equal(visits,1);assert.equal(blocked,3);
  context.claimingOffer=false;(action as unknown as ()=>void)();assert.equal(visits,2);(context.module.exports as ()=>void)();assert.equal(action,null);
});
