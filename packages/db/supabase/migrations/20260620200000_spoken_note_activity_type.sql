/**
* SPOKEN-NOTE ACTIVITY TYPE — a dedicated activity for cover-letter TTS generation.
*
* The spoken-note path (ARC-39) synthesises Archer's audio note for a cover letter
* and records the artifact (audio URL + provider) on the cover-letter version. That
* synthesis is its own kind of activity — not a proposal execution and not the
* Scribe's draft assembly — so it gets its own activity_type value rather than
* overloading 'cover_letter' or 'proposal_exec'. Additive + forward-only: ADD VALUE
* only extends the enum's vocabulary (safe to run in a transaction on PG12+; the new
* value is only referenced by application code, never within this migration).
* Appended AFTER the current last value ('transcribe') so the position is explicit
* (squawk enum ordering).
*/
alter type public.activity_type add value if not exists 'spoken_note' after 'transcribe';
