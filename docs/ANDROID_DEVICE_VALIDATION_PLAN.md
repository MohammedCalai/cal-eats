# Android validation and device performance plan

Audit date: 8 November 2026. This plan separates Android-target bundle checks, shared mobile logic tests, backend capacity checks and measurements on a running Android app. They provide different evidence.

## Available on this computer

- Windows x64, Node 24.19.0, the installed Expo SDK 57 CLI/Metro dependencies, React Native 0.86.2 and the Windows Hermes compiler. An Android-target production JavaScript/Hermes export can be checked locally without downloading an SDK or consuming a cloud build.
- Existing EAS CLI 26.0.0 and independent Cal-Eats build configuration. The primary project is `yankee1707/cal-eats`; the alternate `bondu17` project is restricted to Android. `preview` produces an APK; `production`/`store-test` produce a store AAB. The alternate Android profile uses local signing credentials. The private credentials file exists; its contents were not printed or copied for this audit. Existing private build helpers and older signed Android artifacts are present, but they are not evidence for new source changes.
- Existing Node mobile tests cover API boundaries, sessions, notification models, legal/email-verification state, scheduling, message refresh and other shared logic. They do not render Android UI or exercise FCM on a phone.

No `adb`, emulator, Android SDK/Studio, Java/JDK, Gradle or Maestro was found on PATH or in standard local installation locations. No Android SDK/Java environment variables were configured. Desktop Commander reported no connected devices. No SDK, emulator, remote device, new credentials, hosted native build or paid service was installed or started during the audit.

Consequently, **native Android UI overlap, scrolling/frame performance, startup, memory, ANRs and closed-app notification delivery remain untested on a device**. The old downloaded AAB/APK files cannot establish that the current fixes work. A production JavaScript/Hermes export validates Android dependency resolution, asset bundling and bytecode compilation; its duration is a build-tool measurement, not app startup or runtime throughput. The Windows Hermes compiler is not an Android runtime and cannot provide phone performance measurements.

## Local checks after source is frozen

1. Record the source commit, tracked dirty paths and hashes of the changed mobile files. Keep the export output and command log in a new ignored `artifacts/android-validation-*` folder.
2. Use the already installed Expo CLI for an Android-only production export with Hermes bytecode, bounded bundler workers and dotenv/telemetry disabled. Use only an explicit public API URL and an operating-system environment whitelist. Do not run a native build, prebuild, credentials command or public API request.
3. Confirm a non-empty Android Hermes bundle and exported asset manifest; record sizes and compile duration. Preserve failure logs if export fails. Do not treat success as an APK/AAB, installation, signed release or device test.
4. Run the relevant focused mobile logic regressions after the layout/notification changes settle. Root owns those implementation checks. Do not repeat the 600-order backend load unless ordering/backend source changes justify it.

The [order-load report](./ORDER_CAPACITY_VALIDATION_2026-11-08.md) records 600 synthetic backend order flows at 20/50 workflow clients. It is separate evidence and does not establish Android UI performance. Its background settlement backlog also remains a separate capacity gate.

## Required physical-device session

Use the latest signed internal-test Cal-Eats build, not Expo Go or an old preview. Record version code/source, phone model, Android version, resolution/density, refresh rate, navigation mode, font scale, connection type and battery/thermal state. Keep test accounts and exported device logs private. Use synthetic customer/order data; actual payment/provider actions require their separately authorised test procedure.

At minimum, exercise a small-screen/midrange Android device and a modern Android device at the current target API, with gesture and three-button navigation where available. A desktop browser set to Android dimensions is useful for web checks but is not a substitute.

### Layout and interaction acceptance

| Area | Device action and required observation |
| --- | --- |
| Header and bottom navigation | On all five tabs, scroll up/down, rotate and return from background. Header/logo/basket/notification controls remain usable; bottom tabs remain above system navigation without covering page content. |
| Browse and restaurant menu | Open a category, search, open a shop, jump menu sections and add items. Test long names, image/no-image rows and an empty result. No doubled headers, obscured controls or unexpected cuisine placeholder. |
| Basket and checkout | Adjust quantities, apply an eligible offer automatically, enter a long address and contact number, switch delivery/collection and schedule a time. With the keyboard open, fields, totals and the next action remain reachable and readable. |
| Notifications | Open a long notification list, close it using X, dismiss individual entries and reopen it. Dismissed entries disappear appropriately; controls remain visible at the top and bottom of the list. |
| Messages/support | Open a long conversation, type two lines, send and receive a reply with the keyboard open. The new message stays visible, the composer remains above the keyboard/system bars and Back closes the expected layer. |
| Orders/account | Open a live order, old month groups, saved addresses, help and legal pages. Statuses and actions are readable; back/close controls work; neither tab bar nor overlays hide the final row/action. |
| Accessibility/window changes | Repeat key cases at larger font settings and with an incoming notification or keyboard transition. No trapped modal, clipped primary action or overlapping touch targets. |

Capture screenshots at the failing geometry, including keyboard/system bars, and record exact steps. Fixes should be rechecked on the same device and build. Do not declare visual acceptance from code inspection alone.

### Startup, scroll and memory measurements

Use a signed release-like internal build, stable thermal conditions and a fixed network dataset. Record a warm-up separately; repeat each measured scenario at least three times. Compare an identified baseline and candidate on the same device before making a regression claim. Agree performance limits before using results as a release gate.

- **Startup:** measure at least ten cold and ten warm launches using Android's startup tooling or Macrobenchmark. Distinguish time to initial display from time until useful restaurant content appears; shell launch timing alone does not establish fully drawn/interactive time. Record median/p95 and errors.
- **Scrolling:** record frame timings for a fixed 60-second browse scroll, restaurant menu scroll and long chat, including page loads. Use Macrobenchmark/Perfetto or Android frame statistics, record the display refresh rate and report slow/janky frames and frame-time percentiles. Do not equate network response time with frame time.
- **Growing lists/images:** browse enough pages to expose retained-card/image memory (for example 20 pages of 50 restaurants), then return to the initial tab. Repeat menu/chat navigation for ten minutes. Record loaded-card counts, network bytes, PSS/heap snapshots before/after and after background/resume; watch for monotonic growth, OOM, long stalls and ANRs. This is a device stress scenario, not 10,000 concurrent customers.
- **Background/resume:** with a live order, switch apps/lock/unlock and resume repeatedly over ten minutes. Inspect duplicate polling, stale state and unexpected navigation. Record crashes/ANRs and UI recovery time.
- **Evidence:** collect bounded private frame/memory/crash diagnostics with timestamps and screenshots. Exclude account tokens, message contents and personal notification payloads from shared reports. No performance result is recorded until a real device session supplies it.

The native app uses scrolling lists and remote food images; neither the existing synthetic backend fixture nor a zero-image export proves behavior with a 100 MB business image library. Validate representative optimised image downloads/cache behavior separately from the 1 TB aggregate storage allowance for 10,000 businesses.

### Android notification delivery acceptance

Use an Android signed build with the correct Cal-Eats Firebase configuration and an actual registered push token. A successful server enqueue or Expo acceptance response alone is not a delivered phone alert.

For order confirmation/ETA, dispatch/completion, customer message and personalised offer, record event time, server enqueue/receipt if available, phone banner arrival, unread counter and the screen opened when tapped. Test foreground, background/locked and swiped-away app states separately. Confirm customer notifications stay silent as requested. Test denied permission, re-enabled permission, sign-out/sign-in and changed account without leaking a previous account's messages.

Treat Android system **Force stop** as a distinct operating-system state, not normal backgrounding; document actual behavior instead of promising delivery there. Also test battery saver/background restrictions and record those settings. Provider sends and device interactions are pending this physical-device session; none were performed by this audit.

## References

[Expo CLI export](https://docs.expo.dev/more/expo-cli/#exporting) documents platform-specific export and Hermes generation. [Android benchmarking](https://developer.android.com/topic/performance/benchmarking/benchmarking-overview) describes device-level startup/UI/animation measurement. [Android app performance](https://developer.android.com/topic/performance) covers frame, memory and stability tooling. These are methodological references, not test results for Cal-Eats.
