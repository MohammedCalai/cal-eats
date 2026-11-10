import {PDFDocument} from "pdfkit";
import {fileURLToPath} from "node:url";

const regular=fileURLToPath(new URL("../assets/fonts/NotoSans-Regular.ttf",import.meta.url));
const bold=fileURLToPath(new URL("../assets/fonts/NotoSans-Bold.ttf",import.meta.url));
const logo=fileURLToPath(new URL("../assets/cal-eats-header.png",import.meta.url));
const MAX_BYTES=2*1024*1024,MAX_PAGES=64;
const money=value=>`£${((Number.isSafeInteger(value)?value:0)/100).toFixed(2)}`;
const paymentStatus=value=>({stripe_captured:"Card payment received",stripe_partially_refunded:"Card payment partially refunded",stripe_refunded:"Card payment refunded",cash_collected:"Cash payment recorded by restaurant",cash_paid:"Cash payment recorded by restaurant",voucher_redeemed:"Covered by Cal-Eats voucher",mock_captured:"Test payment - no real money charged"})[value]||"Payment not yet confirmed";
export const receiptPdfFilename=id=>`Cal-Eats-receipt-${String(id).replace(/[^a-zA-Z0-9_-]/g,"").slice(0,60)||"order"}.pdf`;

/** Only saved customer-facing order fields enter this document. No live pricing,
 * bank details, merchant fees, private contact/address or allergy notes are used. */
export function createCustomerReceiptPdf(order){
  return new Promise((resolve,reject)=>{
    const doc=new PDFDocument({size:"A4",margins:{top:156,bottom:82,left:48,right:48},bufferPages:true,compress:true,info:{Title:"Cal-Eats order receipt",Author:"Cal-Eats",Subject:"Completed order receipt"}});
    const chunks=[];let bytes=0,pages=0,fallbackUsed=false;
    doc.on("error",reject);
    doc.on("data",chunk=>{bytes+=chunk.length;if(bytes>MAX_BYTES){doc.destroy(new Error("Receipt is too large to download"));return;}chunks.push(chunk);});
    doc.on("end",()=>resolve(Buffer.concat(chunks)));
    try{
      if(!Array.isArray(order.items)||order.items.length>100)throw Error("Receipt item limit exceeded");
      if(order.items.reduce((n,item)=>n+String(item.name??item.itemName??"").length+(item.selectedModifiers??[]).reduce((m,v)=>m+String(v.optionName||v.name||"").length,0),0)>150000)throw Error("Receipt text limit exceeded");
      doc.registerFont("receipt",regular).registerFont("receipt-bold",bold).font("receipt");
      const supported=doc._font.font;
      const clean=value=>Array.from(String(value??"").replace(/[\u0000-\u001f\u007f]/g," ")).map(char=>{
        if(supported.hasGlyphForCodePoint(char.codePointAt(0)))return char;
        fallbackUsed=true;return `[U+${char.codePointAt(0).toString(16).toUpperCase()}]`;
      }).join("");
      const text=(value,options={})=>doc.text(clean(value),48,doc.y,{align:"left",lineBreak:true,...options});
      const left=48,width=doc.page.width-96;
      const header=()=>{
        if(++pages>MAX_PAGES)throw Error("Receipt page limit exceeded");
        const y=doc.y;doc.save().rect(0,0,doc.page.width,100).fill("#103754");
        doc.image(logo,48,28,{fit:[154,52],align:"left",valign:"center"});
        doc.font("receipt-bold").fontSize(11).fillColor("#FFFFFF").text("ORDER RECEIPT",350,39,{width:197,align:"right",lineBreak:false});
        doc.font("receipt").fontSize(9).fillColor("#D1E9FB").text("Completed order",350,58,{width:197,align:"right",lineBreak:false});doc.restore();
        doc.font("receipt").fontSize(9).fillColor("#506C80").text(`Order ${clean(String(order.id).slice(0,8).toUpperCase())}`,left,119,{width:width/2,lineBreak:false});
        const created=new Date(order.createdAt);const date=Number.isFinite(created.getTime())?new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/London",dateStyle:"medium",timeStyle:"short"}).format(created):"Date unavailable";
        doc.text(date,left+width/2,119,{width:width/2,align:"right",lineBreak:false});doc.y=Math.max(y,156);doc.x=left;
      };
      header();doc.on("pageAdded",header);
      doc.font("receipt-bold").fontSize(21).fillColor("#143D59");text(order.restaurantName,{width});
      doc.moveDown(0.35).font("receipt").fontSize(10).fillColor("#506C80");text(`${order.fulfillment==="delivery"?"Delivery":"Collection"} · ${paymentStatus(order.paymentStatus)}`,{width});
      doc.moveDown(1.2).font("receipt-bold").fontSize(10).fillColor("#143D59");text("YOUR ORDER");doc.moveDown(0.65);
      for(const item of order.items){
        if(!Number.isSafeInteger(item.quantity)||item.quantity<1||String(item.name??item.itemName??"").length>300||!Array.isArray(item.selectedModifiers??[])||(item.selectedModifiers??[]).length>200)throw Error("Receipt item is invalid");
        if(doc.y>doc.page.height-132)doc.addPage();
        const y=doc.y;
        doc.font("receipt-bold").fontSize(11).fillColor("#173E58");
        doc.text(clean(`${item.quantity} × ${item.name??item.itemName??"Item"}`),left,y,{width:width-106});
        const afterName=doc.y;
        doc.text(item.isOfferItem?"Free offer":money(item.lineTotalMinor),left+width-100,y,{width:100,align:"right",lineBreak:false});doc.y=afterName;
        if(item.selectedModifiers?.length){
          doc.font("receipt").fontSize(9).fillColor("#526E82");
          text(item.selectedModifiers.map(modifier=>modifier.optionName||modifier.name||"Option").join(" · "),{width:width-106,lineGap:2});
        }
        doc.moveDown(0.65);doc.save().strokeColor("#E0EBF2").lineWidth(0.6).moveTo(left,doc.y).lineTo(left+width,doc.y).stroke().restore();doc.moveDown(0.75);
      }
      if(doc.y>doc.page.height-310)doc.addPage();
      doc.moveDown(0.7);
      const totalLine=(label,value,strong=false)=>{
        const y=doc.y;doc.font(strong?"receipt-bold":"receipt").fontSize(strong?13:10).fillColor(strong?"#134C79":"#3D5F77");
        doc.text(label,left,y,{width:width-120,lineBreak:false});doc.text(value,left+width-120,y,{width:120,align:"right",lineBreak:false});doc.y=y+(strong?30:24);
      };
      if(order.restaurantDiscountMinor>0){totalLine("Food before restaurant offers",money(order.grossFoodMinor));totalLine("Restaurant offers",`-${money(order.restaurantDiscountMinor)}`);}
      totalLine("Food subtotal",money(order.subtotalMinor));totalLine("Delivery",money(order.deliveryFeeMinor));
      if(order.platformVoucherMinor>0){totalLine("Order value",money(order.totalMinor));totalLine("Cal-Eats voucher",`-${money(order.platformVoucherMinor)}`);}
      doc.moveDown(0.3);totalLine("Customer payment",money(order.customerPayableMinor??order.totalMinor),true);
      if(order.refundedTotalMinor>0)totalLine("Recorded order refunds",money(order.refundedTotalMinor));
      doc.font("receipt").fontSize(9).fillColor("#506C80");text(paymentStatus(order.paymentStatus),{width});
      if(fallbackUsed){doc.moveDown(0.5).fontSize(8);text("Characters outside the receipt font are identified by their Unicode code, for example [U+4E2D].",{width});}
      const range=doc.bufferedPageRange();
      for(let i=range.start;i<range.start+range.count;i++){
        doc.switchToPage(i);const bottom=doc.page.margins.bottom;doc.page.margins.bottom=20;
        doc.save().strokeColor("#D8E7F0").moveTo(left,doc.page.height-57).lineTo(left+width,doc.page.height-57).stroke().restore();
        doc.font("receipt").fontSize(8).fillColor("#5B7488").text("Cal-Eats · support@calai.info",left,doc.page.height-44,{width:width-80,lineBreak:false});
        doc.text(`${i+1} / ${range.count}`,left+width-80,doc.page.height-44,{width:80,align:"right",lineBreak:false});doc.page.margins.bottom=bottom;
      }
      doc.end();
    }catch(error){doc.destroy();reject(error);}
  });
}
