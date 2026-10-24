# Install the Calai Eats browser preview

Calai Eats is prepared as an installable browser app. It is not a native iOS or Android app, and device installation has not yet been verified.

## Requirements

- Use the hosted preview over HTTPS. Service workers and browser installation require a secure context; plain HTTP is suitable only on localhost.
- Use a current browser that supports installing web apps.
- Treat this as a fictional preview. Payments and provider email remain simulated.

## Android

Open the HTTPS preview in Chrome. Open the browser menu and choose **Install app** or **Add to Home screen**, then follow the prompt. The exact label varies by browser and Android version.

## iPhone or iPad

Open the HTTPS preview in Safari. Use **Share**, choose **Add to Home Screen**, review the name, and choose **Add**.

## Offline behavior

The installed shell can show a simple reconnect page when the network is unavailable. Account pages, baskets, orders, receipts and API responses are always fetched from the server and are never saved into the offline cache. Reconnect before relying on any order status.

Before sharing installation instructions publicly, verify the icon, launch behavior, updates and offline screen on the exact supported phone/browser combinations.
