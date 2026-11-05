import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, AppState, Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { colours } from "./theme";

export const CUSTOMER_BANNER_HEIGHT = 60;
export const CUSTOMER_WORDMARK_WIDTH = 134;
const WORDMARK_HEIGHT = CUSTOMER_WORDMARK_WIDTH * 41 / 148;
const IMAGE_WIDTH_RATIO = 1.62425;
const IMAGE_LEFT_RATIO = -0.32036;
const IMAGE_TOP_RATIO = -0.48649;
const LOGO = require("../assets/cal-eats-logo.png");

function useReducedMotion() {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (mounted) setReduced(value); });
    const listener = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => { mounted = false; listener.remove(); };
  }, []);
  return reduced;
}

// The crop ratios and 60/40 split are the same as the approved web wordmark.
// Both animated pieces stay inside a fixed frame, so scrolling never resizes it.
export function CustomerWordmark() {
  const prefix = useRef(new Animated.Value(0)).current;
  const suffix = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();
  useEffect(() => {
    let animation: Animated.CompositeAnimation | undefined;
    const drop = () => {
      animation?.stop();
      if (reduced || AppState.currentState !== "active") { prefix.setValue(0); suffix.setValue(0); return; }
      prefix.setValue(-90); suffix.setValue(-90);
      const piece = (value: Animated.Value, delay: number) => Animated.sequence([
        Animated.delay(delay),
        Animated.timing(value, {toValue: 0, duration: 510, useNativeDriver: true}),
        Animated.timing(value, {toValue: -3, duration: 150, useNativeDriver: true}),
        Animated.timing(value, {toValue: 0, duration: 180, useNativeDriver: true})
      ]);
      animation = Animated.parallel([piece(prefix, 0), piece(suffix, 480)]);
      animation.start();
    };
    drop();
    const timer = setInterval(drop, 30_000);
    const listener = AppState.addEventListener("change", state => { if (state === "active") drop(); else animation?.stop(); });
    return () => { clearInterval(timer); listener.remove(); animation?.stop(); };
  }, [reduced, prefix, suffix]);
  const width = CUSTOMER_WORDMARK_WIDTH, height = WORDMARK_HEIGHT;
  const split = width * 0.6;
  const imageWidth = width * IMAGE_WIDTH_RATIO;
  const image = {width: imageWidth, height: imageWidth * 725 / 2170, top: height * IMAGE_TOP_RATIO};
  return <View accessible accessibilityRole="image" accessibilityLabel="Cal-Eats" style={[s.wordmark, {width, height}]}>
    <Animated.View style={[s.wordmarkPiece, {left: 0, width: split, height, transform: [{translateY: prefix}]}]}>
      <Image accessible={false} accessibilityIgnoresInvertColors source={LOGO} resizeMode="stretch" style={[s.wordmarkImage, image, {left: width * IMAGE_LEFT_RATIO}]}/>
    </Animated.View>
    <Animated.View style={[s.wordmarkPiece, {left: split, width: width - split, height, transform: [{translateY: suffix}]}]}>
      <Image accessible={false} accessibilityIgnoresInvertColors source={LOGO} resizeMode="stretch" style={[s.wordmarkImage, image, {left: width * IMAGE_LEFT_RATIO - split}]}/>
    </Animated.View>
  </View>;
}

type BannerProps = { basketCount?: number; onBasket?: () => void; unreadCount?: number; onBell?: () => void; reminderPending?: boolean; compact?: boolean; onHome?: () => void };
export function CustomerBrandBanner({basketCount = 0, onBasket, unreadCount = 0, onBell, reminderPending = false, onHome}: BannerProps) {
  const {width} = useWindowDimensions();
  const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    pulse.setValue(0);
    if (!reminderPending || reduced) return;
    const animation = Animated.loop(Animated.sequence([
      Animated.timing(pulse, {toValue: 1, duration: 900, useNativeDriver: true}),
      Animated.timing(pulse, {toValue: 0, duration: 900, useNativeDriver: true})
    ]));
    animation.start(); return () => animation.stop();
  }, [reminderPending, reduced, pulse]);
  const wordmark = <CustomerWordmark/>;
  return <View style={s.banner}>
    {onHome ? <Pressable accessibilityRole="button" accessibilityLabel="Cal-Eats home" onPress={onHome} style={s.home}>{wordmark}</Pressable> : <View style={s.home}>{wordmark}</View>}
    <View style={s.controls}>
      {onBasket ? <Pressable accessibilityRole="button" accessibilityLabel={`Open basket, ${basketCount} item${basketCount === 1 ? "" : "s"}`} onPress={onBasket} style={s.basket}>
        <CustomerTabIcon name="basket" active colourOverride={colours.white} size={20}/>
        {width >= 360 ? <Text style={s.basketText}>Basket</Text> : null}
        <View style={s.basketBadge}><Text style={s.basketCount}>{basketCount > 99 ? "99+" : basketCount}</Text></View>
      </Pressable> : null}
      {onBell ? <View style={s.bellFrame}>
        {reminderPending ? <Animated.View pointerEvents="none" style={[s.bellHalo, {opacity: pulse.interpolate({inputRange:[0,1],outputRange:[0.2,0.55]}), transform:[{scale:pulse.interpolate({inputRange:[0,1],outputRange:[1,1.12]})}]}]}/> : null}
        <Pressable accessibilityRole="button" accessibilityLabel={`Notifications, ${unreadCount} unread${reminderPending ? ", new updates need your attention" : ""}`} onPress={onBell} style={[s.bell, reminderPending && s.bellPending]}>
          <CustomerTabIcon name="bell" active colourOverride={colours.white} size={22}/>
          {unreadCount > 0 ? <View style={s.notificationBadge}><Text style={s.notificationCount}>{unreadCount > 99 ? "99+" : unreadCount}</Text></View> : null}
        </Pressable>
      </View> : null}
    </View>
  </View>;
}

export function LiveOrderEnergy() {
  const phase=useRef(new Animated.Value(0)).current;
  useEffect(()=>{let disposed=false,animation:Animated.CompositeAnimation|undefined;void AccessibilityInfo.isReduceMotionEnabled().then(reduced=>{if(disposed||reduced)return;animation=Animated.loop(Animated.sequence([Animated.timing(phase,{toValue:1,duration:2400,useNativeDriver:true}),Animated.timing(phase,{toValue:0,duration:0,useNativeDriver:true})]));animation.start();});const subscription=AccessibilityInfo.addEventListener("reduceMotionChanged",reduced=>{if(reduced)animation?.stop();});return()=>{disposed=true;animation?.stop();subscription.remove();};},[phase]);
  return <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{position:"absolute",left:0,right:0,top:0,bottom:0,overflow:"hidden",borderRadius:16,borderWidth:2,borderColor:"#3EA5FF"}}><Animated.View style={{position:"absolute",top:-30,bottom:-30,width:32,backgroundColor:"#4CAEFF",opacity:.12,transform:[{translateX:phase.interpolate({inputRange:[0,1],outputRange:[-100,650]})},{skewX:"-22deg"}]}}/></View>;
}


const TAB_IMAGES = {
  discover: require("../assets/customer-icons/discover.png"),
  orders: require("../assets/customer-icons/orders.png"),
  offers: require("../assets/customer-icons/offers.png"),
  inbox: require("../assets/customer-icons/messages.png"),
  account: require("../assets/customer-icons/account.png"),
  basket: require("../assets/customer-icons/basket.png"),
  bell: require("../assets/customer-icons/bell.png")
};
export function CustomerTabIcon({name, active, colourOverride, size = 25}: {name: keyof typeof TAB_IMAGES; active: boolean; colourOverride?: string; size?: number}) {
  return <Image accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" source={TAB_IMAGES[name]} resizeMode="contain" style={{width: size, height: size, tintColor: colourOverride || (active ? "#095AAA" : "#547C9F")}}/>;
}

const s = StyleSheet.create({
  banner: {width: "100%", height: CUSTOMER_BANNER_HEIGHT, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, gap: 8, backgroundColor: "#103657", borderBottomWidth: 1, borderBottomColor: "#2E6089", shadowColor: "#0C2F55", shadowOpacity: 0.14, shadowRadius: 9, shadowOffset: {width:0,height:3}, elevation: 3},
  home: {width: CUSTOMER_WORDMARK_WIDTH, minHeight: 44, justifyContent: "center", flexShrink: 0},
  wordmark: {position: "relative", overflow: "hidden", mixBlendMode: "lighten"},
  wordmarkPiece: {position: "absolute", top: 0, overflow: "hidden"},
  wordmarkImage: {position: "absolute"},
  controls: {flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0},
  basket: {minHeight: 44, paddingHorizontal: 7, gap: 5, flexDirection: "row", alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#AACCEB", borderRadius: 12, backgroundColor: "rgba(255,255,255,0.086)"},
  basketText: {fontSize: 12, fontWeight: "700", color: colours.white},
  basketBadge: {height: 18, minWidth: 18, paddingHorizontal: 4, borderRadius: 12, backgroundColor: colours.white, alignItems: "center", justifyContent: "center"},
  basketCount: {fontSize: 10, fontWeight: "800", color: "#124B88"},
  bellFrame: {width: 44, height: 44},
  bell: {width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 14, borderWidth: 1, borderColor: "#91B9DF", backgroundColor: "rgba(255,255,255,0.078)"},
  bellPending: {borderColor: "#B9E3FF", borderWidth: 2},
  bellHalo: {position: "absolute", left: -3, top: -3, width: 50, height: 50, borderRadius: 18, borderWidth: 2, borderColor: "#A3D3FF", backgroundColor: "#63AEFF"},
  notificationBadge: {position: "absolute", right: -4, top: -5, minWidth: 19, height: 19, borderRadius: 11, backgroundColor: "#1767D2", borderWidth: 1, borderColor: "#A8D3FF", alignItems: "center", justifyContent: "center", paddingHorizontal: 3},
  notificationCount: {fontSize: 10, fontWeight: "800", color: colours.white}
});
