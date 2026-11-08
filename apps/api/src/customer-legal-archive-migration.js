export const customerLegalArchiveMigration48 = {
  version: 48,
  name: "immutable_customer_legal_archive_and_order_snapshot",
  sql: `
    CREATE TABLE customer_legal_document_archive (
      document_kind TEXT NOT NULL CHECK(document_kind IN ('terms','privacy')),
      document_version TEXT NOT NULL,
      content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
      text_content TEXT NOT NULL CHECK(length(text_content)>0),
      archived_at TEXT NOT NULL,
      PRIMARY KEY(document_kind,document_version),
      FOREIGN KEY(document_kind,document_version) REFERENCES customer_legal_documents(kind,version)
    );
    CREATE TABLE order_customer_legal_snapshots (
      order_id TEXT NOT NULL REFERENCES orders(id),
      document_kind TEXT NOT NULL CHECK(document_kind IN ('terms','privacy')),
      document_version TEXT NOT NULL,
      document_sha256 TEXT NOT NULL CHECK(length(document_sha256)=64),
      acceptance_id TEXT NOT NULL REFERENCES customer_legal_acceptances(id),
      acknowledged_at TEXT NOT NULL,
      channel TEXT NOT NULL CHECK(channel IN ('web','native')),
      recorded_at TEXT NOT NULL,
      PRIMARY KEY(order_id,document_kind),
      FOREIGN KEY(document_kind,document_version) REFERENCES customer_legal_document_archive(document_kind,document_version)
    );
    CREATE TRIGGER customer_legal_document_archive_immutable BEFORE UPDATE ON customer_legal_document_archive BEGIN
      SELECT RAISE(ABORT,'Legal document archive is immutable');
    END;
    CREATE TRIGGER customer_legal_document_archive_matches_metadata BEFORE INSERT ON customer_legal_document_archive
    WHEN NOT EXISTS(SELECT 1 FROM customer_legal_documents d WHERE d.kind=NEW.document_kind AND d.version=NEW.document_version AND d.content_sha256=NEW.content_sha256) BEGIN
      SELECT RAISE(ABORT,'Legal archive hash must match its approved document');
    END;
    CREATE TRIGGER customer_legal_document_archive_no_delete BEFORE DELETE ON customer_legal_document_archive BEGIN
      SELECT RAISE(ABORT,'Legal document archive must remain available');
    END;
    CREATE TRIGGER order_customer_legal_snapshots_immutable BEFORE UPDATE ON order_customer_legal_snapshots BEGIN
      SELECT RAISE(ABORT,'Order legal snapshot is immutable');
    END;
    CREATE TRIGGER order_customer_legal_snapshots_match_acceptance BEFORE INSERT ON order_customer_legal_snapshots
    WHEN NOT EXISTS(SELECT 1 FROM customer_legal_acceptances a JOIN orders o ON o.customer_id=a.user_id JOIN customer_legal_document_archive d ON d.document_kind=a.document_kind AND d.document_version=a.document_version AND d.content_sha256=a.document_sha256 WHERE o.id=NEW.order_id AND a.id=NEW.acceptance_id AND a.document_kind=NEW.document_kind AND a.document_version=NEW.document_version AND a.document_sha256=NEW.document_sha256 AND a.acknowledged_at=NEW.acknowledged_at AND a.channel=NEW.channel) BEGIN
      SELECT RAISE(ABORT,'Order legal snapshot must match customer acceptance');
    END;
  `
};
