export const USER_SESSION_TABLES = Object.freeze(["sessions", "native_sessions", "native_business_sessions"]);

export function revokeUserSessions(db, userId, stamp, { exceptSessionId = null } = {}) {
  let count = 0;
  for (const table of USER_SESSION_TABLES) {
    count += Number(db.prepare(`UPDATE ${table} SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND expires_at>? ${exceptSessionId ? "AND id<>?" : ""}`)
      .run(stamp, userId, stamp, ...(exceptSessionId ? [exceptSessionId] : [])).changes);
  }
  return count;
}

export function userSessions(db, userId, stamp, currentSessionId) {
  return USER_SESSION_TABLES.flatMap(table => db.prepare(`SELECT id,created_at,expires_at FROM ${table} WHERE user_id=? AND revoked_at IS NULL AND expires_at>?`).all(userId, stamp)
    .map(row => ({ id: row.id, createdAt: row.created_at, expiresAt: row.expires_at, current: row.id === currentSessionId,
      device: table === "sessions" ? "Browser" : table === "native_business_sessions" ? "Cal-Eats Admin" : "Customer app" })))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
