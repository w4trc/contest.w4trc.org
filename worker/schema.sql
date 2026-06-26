CREATE TABLE IF NOT EXISTS qsos (
  id          TEXT PRIMARY KEY,
  call        TEXT NOT NULL,
  band        TEXT NOT NULL,
  mode        TEXT,
  operator    TEXT,
  section     TEXT,
  ts          TEXT,
  ts_epoch    INTEGER,
  points      INTEGER DEFAULT 0,
  is_original INTEGER DEFAULT 1,
  created_at  INTEGER DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_qsos_band     ON qsos(band);
CREATE INDEX IF NOT EXISTS idx_qsos_operator ON qsos(operator);
CREATE INDEX IF NOT EXISTS idx_qsos_section  ON qsos(section);
CREATE INDEX IF NOT EXISTS idx_qsos_tsepoch  ON qsos(ts_epoch);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
