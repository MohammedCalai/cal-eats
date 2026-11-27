# Calai and Cal-Eats together

The combined workspace runs in Calai’s existing business frontend. Calai’s navigation, settings, test-call screen and order notifications remain native. Authorised Cal-Eats tools sit beneath the Calai menu and open within the same window. The dashboard shows each service’s order count and recent orders. The Cal-Eats connection stays mounted when a user navigates through Calai.

This is a Cal-Eats review package. The native frontend patch targets `calai-operation/calai-platform` at `246c09f4a6d224f09a813e20ee496b0eddf5e4df`. The protected-file report records the exact reference tree and changed files. Apply the patch only to a separate review checkout of that commit. The optional native entry is `/owner/dashboard?workspace=both`; direct Calai navigation retains its normal screens.

The two services retain their own authentication and route permissions. The embedded workspace shares only the matched business reference, allowed menu links, order status and totals, and the pending order count. The parent verifies the exact native account and location. A terminal also needs its signed Both assignment. Order acceptance, printing, payments and settings use their existing authorised routes.

Local browser verification used a synthetic restaurant and isolated mock Calai API. The browser displayed both sources on the dashboard, opened Calai Call Summary and Cal-Eats Orders in the same window, and displayed an original Calai order popup while Cal-Eats Orders was open. Installing or reopening on a physical Surface and accepting a real online order require a separate pilot.
