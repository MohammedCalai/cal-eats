import { Modal, type ModalProps } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

// Android modals have their own window. Measure that window rather than reusing
// the main screen's insets, including when the keyboard or system bars change.
export function CustomerModal({ children, ...props }: ModalProps) {
  return <Modal {...props}><SafeAreaProvider>{children}</SafeAreaProvider></Modal>;
}
