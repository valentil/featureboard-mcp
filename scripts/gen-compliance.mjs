#!/usr/bin/env node
/**
 * gen-compliance.mjs (FBMCPF-53) — generate compliance/legal template docs under
 * docs/compliance/, filled from manifest.json (name, author). These are starting
 * points to review with counsel, not legal advice. Run: `node scripts/gen-compliance.mjs`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const NAME = manifest.display_name || manifest.name || "This extension";
const AUTHOR = (manifest.author && manifest.author.name) || "the author";
const DATE = new Date().toISOString().slice(0, 10);
const stamp = `_Template generated ${DATE}. Review with counsel before publishing — not legal advice._`;

const docs = {
  "PRIVACY.md":
`# ${NAME} — Privacy Policy (template)

${stamp}

## What data is processed
${NAME} operates entirely on your local machine. It reads and writes the markdown
board files in the folder you configure (\`FEATUREBOARD_DATA_DIR\`): \`featurelist.md\`,
\`buglist.md\`, \`scratchpad.md\`, \`agent_work_log.md\`, \`test_runs.md\`, and a
\`.featureboard\` index cache.

## What is NOT collected
- No analytics or telemetry.
- No outbound network requests.
- No third-party data sharing.

## Exceptions
- \`request_commercial_license\` records the name/email/company you supply to a local
  file so ${AUTHOR} can follow up about a commercial agreement. It does not transmit
  data automatically; it returns a mailto/URL for you to contact the licensor.

## Your control
All data is local files you own. Delete the boards folder to remove everything.

## Contact
${AUTHOR} — see LICENSE.md / COMMERCIAL-LICENSE.md.
`,
  "DATA_HANDLING.md":
`# ${NAME} — Data Handling (template)

${stamp}

| Aspect | Detail |
| --- | --- |
| Storage location | Local disk, under \`FEATUREBOARD_DATA_DIR\`. |
| Data at rest | Plain markdown + a small JSON index. No encryption applied by the tool. |
| Data in transit | None — the server has no network egress. |
| Retention | Indefinite, controlled by you (the files are yours). |
| Deletion | Remove the board files/folder. \`delete_task\` removes a single ticket. |
| PII | Only what you type into tickets, plus optional license-request contact details. |
| Backups | Not performed by the tool; use your own backup of the boards folder. |
`,
  "SECURITY.md":
`# ${NAME} — Security Notes (template)

${stamp}

## Trust boundary
The server runs locally under your user account and only accesses the configured
boards folder. Project names are validated to stay within that folder (no path
traversal). Writes are atomic (temp file + rename) to avoid corruption.

## Permissions
- Read-only tools carry \`readOnlyHint: true\`; destructive tools carry
  \`destructiveHint: true\`. See docs/TOOLS.md.
- Writes can be gated by the licensing state (\`allowWrites\`).

## Reporting a vulnerability
Contact ${AUTHOR} privately (see LICENSE.md). Do not file security issues publicly.
`,
};

const outDir = path.join(root, "docs", "compliance");
fs.mkdirSync(outDir, { recursive: true });
for (const [file, content] of Object.entries(docs)) {
  fs.writeFileSync(path.join(outDir, file), content, "utf8");
}
console.log(`Wrote ${Object.keys(docs).length} compliance templates to docs/compliance/.`);
