import { useEffect } from "react";
import { connectAutomaticTerminal, terminalApi, terminalStatus } from "./terminal-client.js";

import { configurationChanged, publishNativeMode, nativeOrigin, nativeWatch, readMode, sameConfiguration, startTabletModeWatch } from "./tablet-mode-watch.js";

export default function NativeTabletModeObserver() {
  useEffect(() => {
    if (window === window.parent) return;
    let active = null, stopWatch, signedOut = false;
    const receive = event => {
      const next = nativeWatch(event,window.parent);
      if (signedOut || !next || (active?.nonce === next.nonce && active?.renderedTenantId === next.renderedTenantId &&
        active?.businessId === next.businessId && active?.tabletId === next.tabletId && active?.hostMode === next.hostMode)) return;
      stopWatch?.(); active = next;
      let last;
      stopWatch = startTabletModeWatch({
        read: async signal => {
          const local = terminalStatus();
          if (local.status !== "ready") await connectAutomaticTerminal({managedBusinessId:next.businessId,signal});
          if (signal.aborted || terminalStatus().context?.businessId !== next.businessId) throw Error("Tablet identity changed.");
          return readMode(terminalApi,next.businessId,signal);
        },
        observed: async (observed,signal) => {
          if (observed.tabletId !== next.tabletId) return;
          if (!sameConfiguration(last,observed)) window.dispatchEvent(new CustomEvent(configurationChanged,{detail:observed}));
          last = observed;
          await publishNativeMode({challenge:next,observed,signal,status:terminalStatus,request:terminalApi,
            publish:message => window.parent.postMessage(message,nativeOrigin)});
        }
      });
    };
    const signOut = () => { signedOut = true; stopWatch?.(); };
    window.addEventListener("message",receive);
    window.addEventListener("cal-eats-business-signed-out",signOut);
    window.parent.postMessage({type:"cal-eats-workspace:control-ready",version:1},nativeOrigin);
    return () => { stopWatch?.(); window.removeEventListener("message",receive); window.removeEventListener("cal-eats-business-signed-out",signOut); };
  },[]);
  return null;
}
