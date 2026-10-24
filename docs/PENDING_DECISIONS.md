# Commercial decisions and activation gate

Live payments are disabled in this project. The following remain business decisions; local fixtures do not approve them.

| Topic | Local demo behavior | Required decision |
| --- | --- | --- |
| Commission | 700 basis points, half-up on food subtotal; delivery excluded | Approved base, discount treatment and VAT inclusion |
| Contract | Demo-only 24-month term and version snapshot | Commencement, acceptance text, termination and renewal |
| Customer fees | Zero platform service fee | No change authorized |
| Restaurant fees | No setup/monthly/extra fixed or processing fee | No change authorized |
| Payments | Simulated authorization then capture on acceptance | Connect charge architecture, seller responsibilities and methods |
| Refunds | Explicit local card simulation or manual cash return record | Liability, exceptional losses, disputes and refund policy |
| Cash | Restaurant receives cash; platform records commission receivable | Settlement/collection terms and reconciliation ownership |
| Payouts | No transfer or payout executed | Schedule, reserves, negative balances and provider costs |
| Tailored offers | Explicitly requested merchant-funded free item with next paid order; in-app delivery only | Production marketing preferences, approved promotion terms and operational ownership |
| Automatic loyalty | Deferred: user chose offers only for this phase | Threshold, qualifying orders and earned-reward policy before adding automation |
| Delivery | Restaurant's own drivers, configured postcode coverage | Coverage, fee, minimum, estimates and customer terms per restaurant |
| Food information | Fictional demo merchant data, unverified status | Real merchant allergy/hygiene source verification and ownership |

Do not add VAT, platform fees, promotional subsidies or direct debits by assumption. Do not report gross commission as net profit. A margin estimate must disclose the cost inputs and that they are estimates.

To activate a future provider sandbox, use a separate Calai Eats project and credentials after access is authorized; verify webhooks, retries, captures, refunds, transfer reversals and reconciliation against that actual sandbox. Production additionally requires approved terms, secure bootstrap/MFA, HTTPS, recovery/monitoring, appropriate data retention and market-specific review. Native iOS build/device validation and store submission remain later work; no success is claimed here.
