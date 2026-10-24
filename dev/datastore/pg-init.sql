-- Demo schema: an indexed table (index scans) and a small table without a usable index (sequential scans).
CREATE TABLE survey_answer (id bigserial PRIMARY KEY, expo_id int NOT NULL, payload text NOT NULL);
CREATE INDEX survey_answer_expo_id_idx ON survey_answer (expo_id);
INSERT INTO survey_answer (expo_id, payload) SELECT g % 50, md5(g::text) FROM generate_series(1, 20000) g;
CREATE TABLE expo_code (code text NOT NULL, name text NOT NULL);
INSERT INTO expo_code SELECT 'C' || g, 'expo ' || g FROM generate_series(1, 200) g;
ANALYZE;
