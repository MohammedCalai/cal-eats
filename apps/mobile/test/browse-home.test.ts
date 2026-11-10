import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

test("repeated Browse tabs request home without clearing the basket; pending checkout stays protected", () => {
  const source = ts.createSourceFile("App.tsx", fs.readFileSync(new URL("../App.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler: ts.FunctionDeclaration | undefined;
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === "selectTab") handler = node; ts.forEachChild(node, visit); }
  visit(source); assert.ok(handler);
  const calls: string[] = []; let request = 0;
  const context = { checkout: false, token: "customer", user: {}, pendingCheckout: { current: true }, pendingNotifications: { current: true }, Alert: { alert() { calls.push("checkout-guard"); } }, setBasketOpen() {}, setInboxRoute() {}, setTab() {}, setAuthOpen() {}, setFocusRestaurantId(value: unknown) { assert.equal(value, null); }, setBrowseHomeRequest(update: (n: number) => number) { request = update(request); }, resetHeader() { calls.push("top"); }, module: { exports: null as unknown } };
  vm.runInNewContext(ts.transpileModule(handler!.getText(source) + ";module.exports=selectTab", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const select = context.module.exports as (tab: string) => void;
  select("discover"); select("discover"); assert.equal(request, 2); assert.deepEqual(calls, ["top", "top"]);
  context.checkout = true; select("discover"); assert.equal(request, 2); assert.equal(calls.at(-1), "checkout-guard");
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
  const props: any = { userId: "customer", token: "customer", address: { postcode: "LU1 2BT" }, restaurant, cart: basket, fulfillment: "collection", browseHomeRequest: 0, onCart() { throw Error("Browse must preserve the basket"); }, onRestaurant() { throw Error("Stale menu must not change the restaurant"); }, onScrollOffset(value: number) { offsets.push(value); } };
  function render() { let view: any; for (let pass = 0; pass < 12; pass++) { dirty = false; cursor = 0; effects = []; view = module.exports.DiscoverScreen(props); effects.forEach(effect => effect()); if (!dirty) return view; } throw Error("Hooks did not settle"); }
  assert.equal(render().type, "menu");
  props.browseHomeRequest = 1; let view = render(); assert.equal(view.type, "home"); assert.equal(view.key, 1);
  view.props.onQuery("curry"); view.props.onFilters({ cuisine: "Indian", collection: "popular", offersOnly: true, sort: "quick" }); render();
  props.browseHomeRequest = 2; view = render(); assert.equal(view.type, "home"); assert.equal(view.key, 2); assert.equal(view.props.query, ""); assert.equal(JSON.stringify(view.props.filters), JSON.stringify({ cuisine: "", offersOnly: false, sort: "recommended", collection: "home" }));
  resolveMenu({ restaurant: { id: "saved" }, items: [] }); await Promise.resolve(); await Promise.resolve();
  assert.equal(render().type, "home"); assert.equal(props.cart, basket); assert.equal(props.restaurant, restaurant); assert.equal(view.props.postcode, "LU1 2BT"); assert.equal(offsets.at(-1), 0);
});
