/**
 * FeatureBoard customer portal (FBMCPF-45).
 *
 * Renders a per-customer portal page (the OpenClaw customer_portal.html) showing a
 * company's contacts and its linked board tickets (features/bugs). The company's
 * linked tickets are read from company.tickets (populated by CRM-linked tickets,
 * FBMCPF-47); ticket details are resolved through a caller-supplied lookup so this
 * module stays decoupled from the Board and easy to test.
 *
 * renderPortalHtml is a pure function (company + resolved tickets → self-contained
 * HTML). buildCustomerPortal wires it to the CRM store + a ticket resolver.
 */

import { getCompany } from "./crm.js";

/** Minimal HTML-escape for text interpolated into the portal. */
export function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render a self-contained customer portal page (pure). */
export function renderPortalHtml(company, tickets = []) {
  const name = esc(company && company.name);
  const contacts = Array.isArray(company && company.contacts) ? company.contacts : [];
  const rows = tickets
    .map(
      (t) =>
        `<tr><td>${esc(t.ticketNumber || t.id)}</td><td>${esc(t.type)}</td>` +
        `<td>${esc(t.title)}</td><td class="s s-${esc((t.status || "").toLowerCase().replace(/\s+/g, "-"))}">${esc(t.status)}</td></tr>`
    )
    .join("\n");
  const contactList = contacts
    .map((c) => `<li>${esc(c.name)}${c.role ? ` — ${esc(c.role)}` : ""}${c.email ? ` &lt;${esc(c.email)}&gt;` : ""}</li>`)
    .join("\n");
  const open = tickets.filter((t) => t.status !== "Done").length;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} — Customer Portal</title>
<style>
  :root{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#262624}
  body{max-width:820px;margin:2rem auto;padding:0 1rem;background:#faf9f5}
  h1{margin:.2rem 0}
  .sub{color:#6b6862;margin-bottom:1.5rem}
  table{border-collapse:collapse;width:100%;margin-top:.5rem}
  th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid #e5e2da}
  th{font-size:.8rem;text-transform:uppercase;letter-spacing:.03em;color:#6b6862}
  .s{font-weight:600}.s-done{color:#3f7d4f}.s-in-progress{color:#b8792f}.s-todo{color:#6b6862}
  ul{padding-left:1.1rem}
  .empty{color:#8a867c;font-style:italic}
</style></head>
<body>
  <h1>${name}</h1>
  <div class="sub">Customer portal · ${tickets.length} linked item${tickets.length === 1 ? "" : "s"} · ${open} open</div>
  <h2>Contacts</h2>
  ${contactList ? `<ul>${contactList}</ul>` : `<p class="empty">No contacts on file.</p>`}
  <h2>Your items</h2>
  ${
    rows
      ? `<table><thead><tr><th>Ref</th><th>Type</th><th>Title</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<p class="empty">No linked features or bugs yet.</p>`
  }
</body></html>`;
}

/**
 * Build a customer portal for one company. `resolveTask(id)` returns a ticket
 * object (or null) for each linked ticket id. Returns the html + a summary.
 */
export function buildCustomerPortal(board, project, companyId, resolveTask) {
  const company = getCompany(board, project, companyId);
  const ids = Array.isArray(company.tickets) ? company.tickets : [];
  const tickets = ids.map((id) => resolveTask(id)).filter(Boolean);
  const html = renderPortalHtml(company, tickets);
  return {
    project,
    company: company.id,
    name: company.name,
    ticketCount: tickets.length,
    openCount: tickets.filter((t) => t.status !== "Done").length,
    html,
  };
}
