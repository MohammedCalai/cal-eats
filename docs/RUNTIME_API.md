# Runtime API

`GET /api/runtime` is public and returns:

```json
{"data":{"mode":"local","demoShortcuts":true,"simulatedPayments":true}}
```

`mode` is `local` or `hosted-preview`. Local mode enables clearly labelled demo shortcuts. Hosted preview disables demo shortcuts, requires an explicit HTTPS origin and secure cookies, and rejects write requests without the exact configured `Origin` header. `simulatedPayments` is always `true`; hosted preview is not a production-ready payment deployment.
