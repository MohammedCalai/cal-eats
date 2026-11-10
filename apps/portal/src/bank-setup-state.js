export function bankSetupState({ value, loading = false, error = "" }) {
  const account = value?.account || {};
  const started = Boolean(account.status && account.status !== "not_started");
  const complete = started && account.chargesEnabled === true && account.payoutsEnabled === true && !account.requirements?.length;
  const label = complete ? "Manage bank details" : started ? "Continue bank setup" : "Add bank account";
  const passwordRequired = value?.passwordChangeRequired === true;
  const available = Boolean(value?.configured && !value?.modeMismatch && !passwordRequired && !error && !loading);
  const action = complete ? "dashboard" : "onboarding";
  if (value?.modeMismatch) return { label, action, available: false, passwordRequired, status: "Bank connection needs review", description: "This restaurant’s saved banking belongs to another payment mode. Cal-Eats must complete the reviewed account switch before you can continue." };
  if (error || (!value && !loading)) return { label, action, available: false, passwordRequired, status: "Connection needs attention", description: "We could not verify your bank setup. Refresh the connection before continuing." };
  if (loading) return { label, action, available: false, passwordRequired, status: "Checking bank setup", description: "Checking the secure connection for this restaurant…" };
  if (passwordRequired) return { label, action, available: false, passwordRequired, status: "Secure password required", description: "Save a unique banking password below before adding or changing real bank details." };
  if (!value?.configured) return { label, action, available: false, passwordRequired, status: "Awaiting Cal-Eats connection", description: "Cal-Eats needs to finish connecting this restaurant before you can add bank details. No bank information can be entered yet." };
  if (complete) return { label, action, available, passwordRequired, status: "Bank setup complete", description: "View or change your payout bank account through secure bank setup." };
  return { label, action, available, passwordRequired, status: started ? "Bank setup in progress" : "No bank account added", description: started ? "Continue secure bank setup to complete your business, verification and bank details." : "Add your business and payout bank details securely. Cal-Eats only displays masked bank information." };
}
