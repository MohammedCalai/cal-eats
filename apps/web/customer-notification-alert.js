// The bell acknowledges reminders without marking the underlying updates read.
export function createCustomerNotificationAlert({onChange=()=>{},play=()=>{},visible=()=>true,setTimer=setInterval,clearTimer=clearInterval}={}) {
  let pending = new Set(), acknowledged = new Set(), timer = null, enabled = true, disposed = false;
  const snapshot = () => ({pending:pending.size,soundEnabled:enabled});
  const pulse = () => {if (!disposed && enabled && pending.size && visible()) play();};
  const sync = () => {if(pending.size&&timer===null)timer=setTimer(pulse,10_000);if(!pending.size&&timer!==null){clearTimer(timer);timer=null;}onChange(snapshot());};
  return {
    update(items){if(disposed)return;const next=new Set(items.filter(item=>!item.readAt&&!acknowledged.has(item.id)).map(item=>item.id));const added=[...next].some(id=>!pending.has(id));pending=next;sync();if(added)pulse();},
    acknowledge(items=[]){for(const item of items)acknowledged.add(item.id);for(const id of pending)acknowledged.add(id);acknowledged=new Set([...acknowledged].slice(-400));pending.clear();sync();},
    setSound(value){enabled=Boolean(value);onChange(snapshot());},
    resume(){pulse();},
    snapshot,
    acknowledgedIds(){return [...acknowledged].slice(-400);},
    restoreAcknowledged(ids){acknowledged=new Set(Array.isArray(ids)?ids.filter(id=>typeof id==='string').slice(-400):[]);},
    reset(){pending.clear();acknowledged.clear();enabled=true;sync();},
    dispose(){disposed=true;if(timer!==null)clearTimer(timer);timer=null;pending.clear();}
  };
}
