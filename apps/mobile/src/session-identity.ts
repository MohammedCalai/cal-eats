// Account requests can finish after sign-out or after another customer signs in.
export function bindCustomerProfileUpdate<T extends { id: string }>(
  expectedToken: string,
  expectedUserId: string,
  activeToken: () => string | null,
  update: (user: T) => void
): (user: T) => void {
  return user => {
    if (activeToken() === expectedToken && user.id === expectedUserId) update(user);
  };
}
