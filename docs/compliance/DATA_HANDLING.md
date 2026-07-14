# FeatureBoard — Data Handling (template)

_Template generated 2026-07-13. Review with counsel before publishing — not legal advice._

| Aspect | Detail |
| --- | --- |
| Storage location | Local disk, under `FEATUREBOARD_DATA_DIR`. |
| Data at rest | Plain markdown + a small JSON index. No encryption applied by the tool. |
| Data in transit | None — the server has no network egress. |
| Retention | Indefinite, controlled by you (the files are yours). |
| Deletion | Remove the board files/folder. `delete_task` removes a single ticket. |
| PII | Only what you type into tickets, plus optional license-request contact details. |
| Backups | Not performed by the tool; use your own backup of the boards folder. |
