# FeatureBoard — Data Handling (template)

_Template generated 2026-07-13. Review with counsel before publishing — not legal advice._

| Aspect | Detail |
| --- | --- |
| Storage location | Local disk, under `FEATUREBOARD_DATA_DIR`. |
| Data at rest | Plain markdown + a small JSON index. No encryption applied by the tool. |
| Data in transit | Anonymous usage telemetry (tool-call counts + random install id, daily batch to featureboard.ai — opt out with `FEATUREBOARD_TELEMETRY=0` or `set_global_config telemetry:false`), plus the explicitly-invoked exceptions inventoried in PRIVACY.md (Slack webhook, git push, registration email, license claim, update check, analytics read-proxy, first-run embedding-model download). No board content is ever transmitted. |
| Retention | Indefinite, controlled by you (the files are yours). |
| Deletion | Remove the board files/folder. `delete_task` removes a single ticket. |
| PII | Only what you type into tickets, plus optional license-request contact details. |
| Backups | Not performed by the tool; use your own backup of the boards folder. |
