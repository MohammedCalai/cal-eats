export const customerLegalMigration46 = {
  version: 46,
  name: "versioned_customer_legal_acceptance",
  sql: `
CREATE TABLE customer_legal_documents (
  kind TEXT NOT NULL CHECK(kind IN ('terms','privacy')),
  version TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
  public_url TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  approval_reference TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(kind,version)
);
CREATE TABLE customer_legal_acceptances (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  document_kind TEXT NOT NULL CHECK(document_kind IN ('terms','privacy')),
  document_version TEXT NOT NULL,
  document_sha256 TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('web','native')),
  context TEXT NOT NULL CHECK(context IN ('signup','new_order')),
  UNIQUE(user_id,document_kind,document_version),
  FOREIGN KEY(document_kind,document_version) REFERENCES customer_legal_documents(kind,version)
);
CREATE INDEX customer_legal_acceptances_user_idx ON customer_legal_acceptances(user_id,acknowledged_at);
CREATE TRIGGER customer_legal_documents_immutable BEFORE UPDATE ON customer_legal_documents BEGIN SELECT RAISE(ABORT,'Published legal document versions are immutable'); END;
CREATE TRIGGER customer_legal_acceptances_immutable BEFORE UPDATE ON customer_legal_acceptances BEGIN SELECT RAISE(ABORT,'Historical legal acceptances are immutable'); END;
`
};
