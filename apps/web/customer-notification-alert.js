// The bell acknowledges reminders without marking the underlying updates read.
export function createCustomerNotificationAlert({onChange=()=>{}}={}) {
  let pending = new Set(), acknowledged = new Set(), disposed = false;
  const snapshot = () => ({pending:pending.size});
  const sync = () => onChange(snapshot());
  return {
    update(items){if(disposed)return;const next=new Set(items.filter(item=>!item.readAt&&!acknowledged.has(item.id)).map(item=>item.id));if(next.size===pending.size&&[...next].every(id=>pending.has(id)))return;pending=next;sync();},
    acknowledge(items=[]){for(const item of items)acknowledged.add(item.id);for(const id of pending)acknowledged.add(id);acknowledged=new Set([...acknowledged].slice(-400));pending.clear();sync();},
    snapshot,
    acknowledgedIds(){return [...acknowledged].slice(-400);},
    restoreAcknowledged(ids){acknowledged=new Set(Array.isArray(ids)?ids.filter(id=>typeof id==='string').slice(-400):[]);},
    reset(){pending.clear();acknowledged.clear();sync();},
    dispose(){disposed=true;pending.clear();}
  };
}

export function shouldShowCustomerNotificationPrompt({customer,pending,hidden=false,busy=false,view="",hasDialog=false}={}) {
  return Boolean(customer && pending > 0 && !hidden && !busy && !hasDialog && !["messages","basket","checkout"].includes(view));
}
