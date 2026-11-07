import { Platform } from "react-native";
import Constants from "expo-constants";
import { HStack, Image, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import { accessibilityElement, accessibilityLabel, activityBackgroundTint, font, foregroundStyle, frame, lineLimit, padding, resizable } from "@expo/ui/swift-ui/modifiers";
import { createLiveActivity, type LiveActivityEnvironment } from "expo-widgets";
import type { LiveOrderContent } from "./live-activity-model";

// The widget compiler serializes this function in isolation. All layout values
// remain in its body; no app hooks, customer context or async/network work runs.
const CalEatsOrderLayout = (props: LiveOrderContent, environment: LiveActivityEnvironment) => {
  "widget";
  const blue = environment.isLuminanceReduced ? "#8BCBFF" : "#36A8FF";
  const primary = environment.colorScheme === "dark" ? "#FFFFFF" : "#123956";
  const secondary = environment.colorScheme === "dark" ? "#BFD8ED" : "#496C89";
  const status = environment.isStale ? "Open Cal-Eats for an update" : props.statusLabel;
  const eta = environment.isStale && props.etaUnix ? `Last estimate · ${props.etaLabel}` : props.etaLabel;
  const clock = props.etaLabel.match(/\b\d{2}:\d{2}\b/)?.[0];
  const compact = environment.isStale ? "Update" : clock || (props.fulfillment === "collection" && props.statusLabel.toLowerCase().includes("ready") ? "Ready" : "Live");
  const spoken = `Cal-Eats. ${props.restaurantName}. ${status}. ${eta}`;
  return {
    banner: <VStack alignment="leading" spacing={9} modifiers={[padding({ all: 15 }), activityBackgroundTint(environment.colorScheme === "dark" ? "#102C45" : "#EAF5FF"), accessibilityElement("ignore"), accessibilityLabel(spoken)]}>
      <HStack spacing={8}><Image assetName="CalEatsLiveSymbol" modifiers={[resizable(), frame({ width: 26, height: 26 })]}/><Text modifiers={[font({ size: 16, weight: "bold" }), foregroundStyle(blue)]}>Cal-Eats</Text><Spacer/><Text modifiers={[font({ size: 11, weight: "medium" }), foregroundStyle(secondary)]}>{props.fulfillment === "delivery" ? "DELIVERY" : "COLLECTION"}</Text></HStack>
      <Text modifiers={[font({ size: 17, weight: "semibold" }), foregroundStyle(primary), lineLimit(1)]}>{status}</Text>
      <HStack spacing={12}><Text modifiers={[font({ size: 12 }), foregroundStyle(secondary), lineLimit(1)]}>{props.restaurantName}</Text><Spacer/><Text modifiers={[font({ size: 13, weight: "semibold" }), foregroundStyle(primary), lineLimit(1)]}>{eta}</Text></HStack>
    </VStack>,
    compactLeading: <Image assetName="CalEatsLiveSymbol" modifiers={[resizable(), frame({ width: 22, height: 22 }), accessibilityLabel("Cal-Eats live order")]}/>,
    compactTrailing: <Text modifiers={[font({ size: 12, weight: "semibold" }), foregroundStyle(blue), accessibilityLabel(spoken)]}>{compact}</Text>,
    minimal: <Image assetName="CalEatsLiveSymbol" modifiers={[resizable(), frame({ width: 20, height: 20 }), accessibilityLabel(spoken)]}/>,
    expandedLeading: <HStack spacing={7}><Image assetName="CalEatsLiveSymbol" modifiers={[resizable(), frame({ width: 25, height: 25 })]}/><Text modifiers={[font({ size: 14, weight: "bold" }), foregroundStyle(blue)]}>Cal-Eats</Text></HStack>,
    expandedTrailing: <Text modifiers={[font({ size: 15, weight: "bold" }), foregroundStyle(blue), accessibilityLabel(eta)]}>{compact}</Text>,
    expandedBottom: <VStack alignment="leading" spacing={5} modifiers={[padding({ top: 8, bottom: 5 }), accessibilityElement("ignore"), accessibilityLabel(spoken)]}><Text modifiers={[font({ size: 16, weight: "semibold" }), foregroundStyle("#FFFFFF"), lineLimit(1)]}>{status}</Text><Text modifiers={[font({ size: 12 }), foregroundStyle("#BFD8ED"), lineLimit(1)]}>{props.restaurantName} · {eta}</Text></VStack>
  };
};
export const liveOrderFactory = createLiveActivity<LiveOrderContent>("CalEatsOrderActivity", CalEatsOrderLayout);
export const liveOrderActivitiesSupported = Constants.appOwnership !== "expo" && Number.parseFloat(String(Platform.Version)) >= 16.4;
