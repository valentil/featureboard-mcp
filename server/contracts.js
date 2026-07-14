/**
 * FeatureBoard standard contracts / templates (FBMCPF-46).
 *
 * Ports the OpenClaw standardContracts generator: a small library of fill-in
 * contract templates (NDA, MSA, SOW, and a FeatureBoard commercial license that
 * ties into the licensing/CRM flow). Templates use {{placeholder}} tokens; render
 * fills them from provided vars (optionally auto-filled from a CRM company) and
 * leaves any un-provided optional tokens as a blank line for manual completion.
 *
 * These are convenience drafts, not legal advice — generated documents are stamped
 * to review with counsel. Pure helpers (listTemplates, renderContract) are exported
 * for tests; generateContract wires in the CRM + media gallery.
 */

import { getCompany } from "./crm.js";
import { saveMedia } from "./media.js";

const STAMP = "\n\n---\n_Draft generated from a standard template — review with counsel before signing._\n";

export const TEMPLATES = {
  nda: {
    id: "nda",
    title: "Mutual Non-Disclosure Agreement",
    description: "Two-way confidentiality agreement.",
    required: ["customer_name", "provider", "effective_date"],
    body: `# Mutual Non-Disclosure Agreement

This Mutual Non-Disclosure Agreement ("Agreement") is entered into as of {{effective_date}} between {{provider}} ("Provider") and {{customer_name}} ("Counterparty").

1. **Confidential Information.** Each party may disclose confidential business and technical information to the other. The receiving party will use it solely to evaluate and pursue a business relationship.

2. **Obligations.** The receiving party will protect the disclosing party's confidential information with at least reasonable care and will not disclose it to third parties without consent.

3. **Term.** Confidentiality obligations survive for {{term}} from the effective date.

4. **Governing law.** This Agreement is governed by the laws of {{governing_law}}.

Signed:

{{provider}} ____________________     {{customer_name}} ____________________`,
  },
  msa: {
    id: "msa",
    title: "Master Services Agreement",
    description: "Framework agreement for ongoing services.",
    required: ["customer_name", "provider", "effective_date"],
    body: `# Master Services Agreement

This Master Services Agreement is made on {{effective_date}} between {{provider}} ("Provider") and {{customer_name}} ("Client").

1. **Services.** Provider will perform the services described in one or more Statements of Work referencing this Agreement.
2. **Fees.** Client will pay the fees set out in each SOW within {{payment_terms}} of invoice.
3. **Term & termination.** This Agreement continues until terminated by either party on {{notice_period}} written notice.
4. **Confidentiality & IP.** Each party retains its pre-existing IP; deliverables transfer to Client on payment.
5. **Governing law.** {{governing_law}}.

Signed:

{{provider}} ____________________     {{customer_name}} ____________________`,
  },
  sow: {
    id: "sow",
    title: "Statement of Work",
    description: "Scoped deliverables under an MSA.",
    required: ["customer_name", "provider", "effective_date", "scope"],
    body: `# Statement of Work

SOW dated {{effective_date}} under the Master Services Agreement between {{provider}} and {{customer_name}}.

**Scope of work:**
{{scope}}

**Timeline:** {{timeline}}

**Fees:** {{fees}}

**Acceptance:** Deliverables are accepted when they meet the criteria above.

Signed:

{{provider}} ____________________     {{customer_name}} ____________________`,
  },
  license: {
    id: "license",
    title: "FeatureBoard Commercial License",
    description: "Commercial license grant (ties into the licensing flow).",
    required: ["customer_name", "provider", "effective_date", "seats"],
    body: `# FeatureBoard Commercial License

This Commercial License is granted on {{effective_date}} by {{provider}} to {{customer_name}} ("Licensee").

1. **Grant.** Provider grants Licensee a non-exclusive, non-transferable license to use FeatureBoard for commercial purposes for {{seats}} seat(s).
2. **Term.** {{term}}, renewable.
3. **Fees.** {{fees}}.
4. **Restrictions.** Licensee will not sublicense, resell, or remove licensing notices.
5. **Support.** {{support}}.
6. **Governing law.** {{governing_law}}.

Signed:

{{provider}} ____________________     {{customer_name}} ____________________`,
  },
};

/** List available contract templates with their required fields. */
export function listTemplates() {
  return {
    count: Object.keys(TEMPLATES).length,
    templates: Object.values(TEMPLATES).map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      required: t.required,
    })),
  };
}

/** All {{tokens}} referenced in a template body. */
export function templateFields(templateId) {
  const t = TEMPLATES[templateId];
  if (!t) throw new Error(`unknown template "${templateId}" (use list_contract_templates)`);
  const set = new Set();
  for (const m of t.body.matchAll(/\{\{(\w+)\}\}/g)) set.add(m[1]);
  return [...set];
}

/**
 * Render a contract from a template + vars (pure). Throws if a required field is
 * missing; any other unfilled token becomes a blank line for manual completion.
 * Returns the filled markdown plus which optional fields were left blank.
 */
export function renderContract(templateId, vars = {}) {
  const t = TEMPLATES[templateId];
  if (!t) throw new Error(`unknown template "${templateId}" (use list_contract_templates)`);
  const missing = t.required.filter((f) => vars[f] == null || String(vars[f]).trim() === "");
  if (missing.length) throw new Error(`missing required field(s) for ${templateId}: ${missing.join(", ")}`);
  const leftBlank = [];
  const filled = t.body.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (vars[key] != null && String(vars[key]).trim() !== "") return String(vars[key]);
    if (!t.required.includes(key)) leftBlank.push(key);
    return "________";
  });
  return { templateId, title: t.title, markdown: filled + STAMP, leftBlank: [...new Set(leftBlank)] };
}

/**
 * Generate a contract, optionally auto-filling customer_name from a CRM company and
 * saving the result into the media gallery. Returns the rendered contract (+ saved
 * path when save is set).
 */
export function generateContract(board, project, { template, vars = {}, company, save } = {}, { now = new Date() } = {}) {
  const merged = { ...vars };
  if (company) {
    const c = getCompany(board, project, company);
    if (merged.customer_name == null) merged.customer_name = c.name;
  }
  const rendered = renderContract(template, merged);
  if (save) {
    const slug = company || "contract";
    const stamp = now.toISOString().slice(0, 10);
    const saved = saveMedia(board, project, {
      name: `contract-${slug}-${template}-${stamp}.md`,
      content: rendered.markdown,
      title: rendered.title,
      tags: ["contract", template],
    });
    return { ...rendered, saved: saved.relPath };
  }
  return rendered;
}
