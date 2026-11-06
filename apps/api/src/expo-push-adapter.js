const base="https://exp.host/--/api/v2/push/";
const ticketId=value=>typeof value==="string"&&/^[A-Za-z0-9_-]{8,150}$/.test(value);
function failure(code){return code==="DeviceNotRegistered"?{status:"invalid_device",errorCode:"PUSH_DEVICE_NOT_REGISTERED"}:code==="MessageRateExceeded"?{status:"retry",errorCode:"PUSH_RATE_LIMITED"}:{status:"failed",errorCode:code==="InvalidCredentials"||code==="MismatchSenderId"?"PUSH_INVALID_CREDENTIALS":"PUSH_REQUEST_REJECTED"};}

/** Fixed Expo endpoints; tokens, access credentials and raw provider errors are never logged. */
export function createExpoPushAdapter(settings,{fetchImpl=globalThis.fetch}={}){
  if(!settings?.enabled||!settings.accessToken)throw new Error("Expo push delivery requires an enabled private sender connection");
  const request=async(path,body)=>{
    let response;try{response=await fetchImpl(base+path,{method:"POST",redirect:"error",signal:AbortSignal.timeout(10000),headers:{Accept:"application/json","Content-Type":"application/json",Authorization:`Bearer ${settings.accessToken}`},body:JSON.stringify(body)});}catch{return {status:"retry",errorCode:"PUSH_NETWORK_RETRY"};}
    if(response.status===429)return {status:"retry",errorCode:"PUSH_RATE_LIMITED"};
    if(!response.ok)return {status:response.status>=500?"retry":"failed",errorCode:response.status===401||response.status===403?"PUSH_AUTHORIZATION_FAILED":"PUSH_PROVIDER_UNAVAILABLE"};
    try{return {status:"response",body:await response.json()};}catch{return {status:"unknown",errorCode:"PUSH_INVALID_RESPONSE"};}
  };
  return {
    async send(payload,{beforeSend}){
      if(!beforeSend())return {status:"cancelled"};
      const response=await request("send",payload);if(response.status!=="response")return response;
      const ticket=Array.isArray(response.body?.data)?response.body.data.length===1?response.body.data[0]:null:response.body?.data;
      if(ticket?.status==="ok"&&ticketId(ticket.id))return {status:"accepted",ticketId:ticket.id};
      if(ticket?.status==="error")return failure(ticket.details?.error);
      return {status:"unknown",errorCode:"PUSH_TICKET_UNVERIFIED"};
    },
    async receipt(id){
      if(!ticketId(id))return {status:"failed",errorCode:"PUSH_RECEIPT_INVALID"};
      const response=await request("getReceipts",{ids:[id]});if(response.status!=="response")return response;
      const receipt=response.body?.data?.[id];if(!receipt)return {status:"pending"};
      return receipt.status==="ok"?{status:"receipt_confirmed"}:receipt.status==="error"?failure(receipt.details?.error):{status:"pending"};
    }
  };
}
