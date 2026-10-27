import assert from "node:assert/strict";
import test from "node:test";
import { promotionBadge, promotionPreferenceModel, promotionPriceLines } from "../loyalty-ui.js";

test("promotion price lines reconcile gross, restaurant discount and net total",()=>{const lines=promotionPriceLines({grossFoodMinor:2000,restaurantDiscountMinor:500,subtotalMinor:1500,deliveryFeeMinor:250,totalMinor:1750});assert.deepEqual(lines.map(x=>x.minor),[2000,-500,1500,250,1750]);});
test("marketing preferences fail closed and keep push separate",()=>{assert.deepEqual(promotionPreferenceModel({}),{inAppPromotions:false,pushPromotions:false,consentVersion:"loyalty-v1",updatedAt:null});assert.equal(promotionPreferenceModel({inAppPromotions:true}).pushPromotions,false);});
test("promotion badges distinguish supported offer types",()=>{assert.equal(promotionBadge({offerType:"percent_off",value:1000}),"10% off");assert.equal(promotionBadge({offerType:"fixed_off",value:500}),"£5.00 off");assert.equal(promotionBadge({offerType:"free_item",itemName:"Side"}),"Free Side");});
