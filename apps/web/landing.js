// Preserve previously issued account links after moving ordering to /order/.
// Tokens stay in the fragment and are consumed by the customer app, never sent
// to the server or a third-party service by this hand-off.
if (/^#(?:reset-password|verify-email)=/.test(location.hash)) {
  location.replace(`/order/${location.hash}`);
}
