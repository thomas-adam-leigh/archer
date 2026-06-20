/**
* VOICENOTE ACTIVITY TYPE — a dedicated activity for STT transcription ingest.
*
* The voicenote ingest path (ARC-30) turns an uploaded audio reference into a
* transcript message (tier-2 memory). That ingest is its own kind of activity —
* not a proposal execution — so it gets its own activity_type value rather than
* overloading 'proposal_exec'. Additive + forward-only: ADD VALUE only extends the
* enum's vocabulary (safe to run in a transaction on PG12+; the new value is only
* referenced by application code, never within this migration). Appended AFTER the
* current last value ('deploy') so the position is explicit (squawk enum ordering).
*/
alter type public.activity_type add value if not exists 'transcribe' after 'deploy';
