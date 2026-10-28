export const customerMessageSequenceMigration25 = {
  version: 25,
  name: "durable_customer_message_ingestion_sequence",
  sql: `
ALTER TABLE restaurant_customer_messages ADD COLUMN ingest_sequence INTEGER NOT NULL DEFAULT 0 CHECK(ingest_sequence>=0);
UPDATE restaurant_customer_messages SET ingest_sequence=rowid;
CREATE UNIQUE INDEX restaurant_customer_message_sequence_idx ON restaurant_customer_messages(thread_id,ingest_sequence);
ALTER TABLE restaurant_customer_message_reads ADD COLUMN last_read_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_read_sequence>=0);
UPDATE restaurant_customer_message_reads SET last_read_sequence=COALESCE((
  SELECT m.ingest_sequence FROM restaurant_customer_messages m
  WHERE m.thread_id=restaurant_customer_message_reads.thread_id AND m.id=restaurant_customer_message_reads.last_read_message_id
),0);
CREATE TABLE restaurant_customer_thread_sequences (
  thread_id TEXT PRIMARY KEY REFERENCES restaurant_customer_threads(id) ON DELETE CASCADE,
  last_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_sequence>=0)
);
INSERT INTO restaurant_customer_thread_sequences(thread_id,last_sequence)
SELECT t.id,COALESCE(MAX(m.ingest_sequence),0)
FROM restaurant_customer_threads t LEFT JOIN restaurant_customer_messages m ON m.thread_id=t.id GROUP BY t.id;
`
};
