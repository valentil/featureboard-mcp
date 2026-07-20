// Auto-extracted from server/index.js (FBMCPF-224). Registration blocks moved verbatim.
export function registerCrmTools(server, ctx) {
  const { Board, addAgreement, addCompany, addContact, addInboxMessage, addInteraction, addLead, addLeadArea, book, buildCustomerPortal, cancelBooking, companiesForTicket, companyPriorityTickets, convertLead, enrichLead, generateContract, getBoard, getCompany, leadsMap, license, linkTicket, listBookings, listCompanies, listInbox, listLeadAreas, listLeads, listTemplates, removeAgreement, removeContact, reportCompanyBug, resolveCompanyBug, reviewInboxMessage, saveMedia, setCompanyProducts, setLeadStatus, submitIntake, tryTool, unlinkTicket, updateAgreement, updateContact, updateLeadLocation, withOrchestrationLabels, writeTool, z } = ctx;

// CRM ----------------------------------------------------------------------

server.registerTool(
  "add_company",
  {
    title: "Add a CRM company",
    description:
      "Create a company in the project's CRM (crm/companies/<slug>.json). Slug is derived from the name and de-duplicated. Returns the new company record.",
    inputSchema: {
      project: z.string(),
      name: z.string(),
      domain: z.string().optional(),
      notes: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, domain, notes }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return addCompany(board, project, { name, domain, notes });
  })
);

server.registerTool(
  "list_companies",
  {
    title: "List CRM companies",
    description: "List the project's CRM companies (id, name, domain, contact count, products), alphabetical by name. Pass product to show only companies associated with that product.",
    inputSchema: { project: z.string(), product: z.string().optional().describe("Filter to companies associated with this product.") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, product }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listCompanies(board, project, { product });
  })
);

server.registerTool(
  "set_company_products",
  {
    title: "Set a company's products",
    description: "Record which products a company uses/owns (replaces the list; de-duplicated). Surfaced on the company record and usable via list_companies(product=...).",
    inputSchema: {
      project: z.string(),
      company: z.string().describe("Company id (slug)."),
      products: z.array(z.string()).describe("Full product list for the company (replaces any existing)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, company, products }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return setCompanyProducts(board, project, company, products);
  })
);

server.registerTool(
  "get_company",
  {
    title: "Get a CRM company",
    description: "Full company record including its contacts. Throws if the company id isn't found.",
    inputSchema: { project: z.string(), id: z.string().describe("Company id (slug) from list_companies.") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, id }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return getCompany(board, project, id);
  })
);

server.registerTool(
  "add_contact",
  {
    title: "Add a CRM contact",
    description: "Add a contact (name, email, role, phone) to a company. Contact ids are unique within the company.",
    inputSchema: {
      project: z.string(),
      company: z.string().describe("Company id (slug)."),
      name: z.string(),
      email: z.string().optional(),
      role: z.string().optional(),
      phone: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, company, name, email, role, phone }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return addContact(board, project, company, { name, email, role, phone });
  })
);

server.registerTool(
  "update_contact",
  {
    title: "Update a CRM contact",
    description: "Edit a contact on a company (only provided fields change). Pass an empty string to clear email/role/phone.",
    inputSchema: {
      project: z.string(),
      company: z.string().describe("Company id (slug)."),
      contact: z.string().describe("Contact id within the company (e.g. c1)."),
      name: z.string().optional(),
      email: z.string().optional(),
      role: z.string().optional(),
      phone: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, company, contact, name, email, role, phone }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return updateContact(board, project, company, contact, { name, email, role, phone });
  })
);

server.registerTool(
  "remove_contact",
  {
    title: "Remove a CRM contact",
    description: "Remove a contact from a company by its contact id (e.g. c1).",
    inputSchema: {
      project: z.string(),
      company: z.string().describe("Company id (slug)."),
      contact: z.string().describe("Contact id within the company (e.g. c1)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, company, contact }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return removeContact(board, project, company, contact);
  })
);

server.registerTool(
  "add_crm_message",
  {
    title: "Add a CRM inbox message",
    description:
      "Add an incoming message to the CRM inbox (starts pending review). Useful for logging inbound emails/leads that need triage and approval.",
    inputSchema: {
      project: z.string(),
      subject: z.string().optional(),
      body: z.string().optional(),
      from: z.string().optional(),
      company: z.string().optional().describe("Related company id, if known."),
      type: z.enum(["support", "sales", "contact", "feedback", "other"]).optional().describe("Submission category."),
      email: z.string().optional().describe("Requester email."),
      name: z.string().optional().describe("Requester name."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, subject, body, from, company, type, email, name }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return addInboxMessage(board, project, { subject, body, from, company, type, email, name });
  })
);

server.registerTool(
  "submit_crm_intake",
  {
    title: "Submit a support/contact request",
    description:
      "Capture an inbound support or contact submission (support-info / crm-submit) into the CRM inbox, pending review. Records the requester (name/email), a category (support/sales/contact/feedback/other), an optional related company, and the message; synthesizes a subject if none is given.",
    inputSchema: {
      project: z.string(),
      type: z.enum(["support", "sales", "contact", "feedback", "other"]).optional().default("contact"),
      name: z.string().optional().describe("Requester name."),
      email: z.string().optional().describe("Requester email."),
      company: z.string().optional().describe("Related company id, if known."),
      subject: z.string().optional(),
      message: z.string().describe("The submission body."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, type, name, email, company, subject, message }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return submitIntake(board, project, { type, name, email, company, subject, message });
  })
);

server.registerTool(
  "list_crm_inbox",
  {
    title: "List CRM inbox",
    description: "List CRM inbox messages (newest-first), optionally filtered by status (pending/approved/rejected), company, and/or type (support/sales/contact/feedback/other).",
    inputSchema: {
      project: z.string(),
      status: z.enum(["pending", "approved", "rejected"]).optional(),
      company: z.string().optional(),
      type: z.enum(["support", "sales", "contact", "feedback", "other"]).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, status, company, type }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listInbox(board, project, { status, company, type });
  })
);

server.registerTool(
  "review_crm_message",
  {
    title: "Review a CRM inbox message",
    description: "Approve or reject a pending CRM inbox message by id. Records the decision and timestamp.",
    inputSchema: {
      project: z.string(),
      id: z.string(),
      decision: z.enum(["approve", "reject"]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, id, decision }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return reviewInboxMessage(board, project, id, decision);
  })
);

server.registerTool(
  "add_lead",
  {
    title: "Add a lead",
    description:
      "Add a sales lead to the project's leads store (crm/leads.json). Status defaults to 'new' (pipeline: new → contacted → qualified → won/lost). Optional value and lat/lng power the pipeline value and the leads map.",
    inputSchema: {
      project: z.string(),
      name: z.string(),
      company: z.string().optional(),
      email: z.string().optional(),
      source: z.string().optional(),
      value: z.number().optional().describe("Estimated deal value."),
      city: z.string().optional(),
      lat: z.number().optional(),
      lng: z.number().optional(),
      status: z.enum(["new", "contacted", "qualified", "won", "lost"]).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, company, email, source, value, city, lat, lng, status }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return addLead(board, project, { name, company, email, source, value, city, lat, lng, status });
  })
);

server.registerTool(
  "list_leads",
  {
    title: "List leads",
    description: "List leads (newest-first), optionally filtered by pipeline status and/or company.",
    inputSchema: {
      project: z.string(),
      status: z.enum(["new", "contacted", "qualified", "won", "lost"]).optional(),
      company: z.string().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, status, company }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listLeads(board, project, { status, company });
  })
);

server.registerTool(
  "set_lead_status",
  {
    title: "Set lead status",
    description: "Move a lead along the pipeline (new/contacted/qualified/won/lost). Records the update time.",
    inputSchema: {
      project: z.string(),
      id: z.string(),
      status: z.enum(["new", "contacted", "qualified", "won", "lost"]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, id, status }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return setLeadStatus(board, project, id, status);
  })
);

server.registerTool(
  "enrich_lead",
  {
    title: "Enrich a lead",
    description:
      "Record website-sourced details on a lead (only provided fields are set): website, domain, phone, industry, description, contactName, employees, email, city, source, value. Use the pull_lead_website prompt to fetch + extract these from the lead's site first, then persist them here.",
    inputSchema: {
      project: z.string(),
      id: z.string().describe("Lead id, e.g. L3."),
      website: z.string().optional(),
      domain: z.string().optional(),
      phone: z.string().optional(),
      industry: z.string().optional(),
      description: z.string().optional(),
      contactName: z.string().optional(),
      employees: z.string().optional(),
      email: z.string().optional(),
      city: z.string().optional(),
      source: z.string().optional(),
      value: z.coerce.number().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, id, ...fields }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return enrichLead(board, project, id, fields);
  })
);

server.registerTool(
  "convert_lead",
  {
    title: "Convert a lead to a company",
    description:
      "Convert a qualified lead into a CRM company, carrying over its fields (name, website→domain, a notes summary) and optionally seeding a contact from the lead's person/email/phone. Marks the lead won and records the company it became. Errors if already converted.",
    inputSchema: {
      project: z.string(),
      id: z.string().describe("Lead id, e.g. L3."),
      companyName: z.string().optional().describe("Override the company name (defaults to the lead's company or name)."),
      createContact: z.boolean().optional().default(true).describe("Seed a company contact from the lead."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, id, companyName, createContact }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return convertLead(board, project, id, { companyName, createContact }, { crm: { addCompany, addContact } });
  })
);

server.registerPrompt(
  "pull_lead_website",
  {
    title: "Enrich a lead from its website",
    description: "Fetch a lead's website, extract company details, and save them onto the lead via enrich_lead.",
    argsSchema: {
      project: z.string().optional(),
      id: z.string().optional().describe("Lead id to enrich."),
      url: z.string().optional().describe("Website URL (defaults to the lead's website field)."),
    },
  },
  ({ project, id, url } = {}) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Enrich lead${id ? ` ${id}` : ""}${project ? ` in project "${project}"` : ""} from its website.\n\n` +
            "Steps:\n" +
            (id ? "" : "- Ask which lead (or list_leads to find it).\n") +
            `- Determine the URL${url ? ` (${url})` : " (use the provided url, or the lead's existing website field — list_leads shows it)"}. If there's no URL, ask for one.\n` +
            "- Fetch the site (web_fetch) and read the home/about/contact pages.\n" +
            "- Extract what you can: a one-line description, industry, headquarters city, a phone, a general contact name/email, rough employee count, and the canonical domain.\n" +
            "- Call enrich_lead with the fields you found (leave unknowns out — don't guess).\n" +
            "- Confirm what was added, and offer to convert_lead it into a company if it looks qualified.",
        },
      },
    ],
  })
);

server.registerTool(
  "leads_map",
  {
    title: "Leads map",
    description:
      "Geographic + pipeline rollup for the leads map: mappable points (leads with lat/lng), counts by status and by city, geocoded/ungeocoded tally, and total pipeline value. Rendering is left to the board or a generated report.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return leadsMap(board, project);
  })
);

server.registerTool(
  "add_lead_area",
  {
    title: "Add a lead area",
    description:
      "Define a circular geographic area (name + centre lat/lng + radius km) for the leads map. leads_map then tags each mapped lead with the areas it falls in and rolls up lead counts + pipeline value per area.",
    inputSchema: {
      project: z.string(),
      name: z.string(),
      lat: z.coerce.number(),
      lng: z.coerce.number(),
      radiusKm: z.coerce.number().describe("Area radius in kilometres (positive)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, lat, lng, radiusKm }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return addLeadArea(board, project, { name, lat, lng, radiusKm });
  })
);

server.registerTool(
  "list_lead_areas",
  {
    title: "List lead areas",
    description: "List the defined geographic lead areas (id, name, centre, radius).",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listLeadAreas(board, project);
  })
);

server.registerTool(
  "add_lead_interaction",
  {
    title: "Log a lead interaction",
    description:
      "Append a touchpoint to a lead's interaction log: kind (call/email/meeting/note/visit/other) + a note, timestamped. Builds the per-lead history.",
    inputSchema: {
      project: z.string(),
      id: z.string().describe("Lead id, e.g. L3."),
      kind: z.enum(["call", "email", "meeting", "note", "visit", "other"]).optional().default("note"),
      note: z.string(),
      at: z.string().optional().describe("ISO timestamp (defaults to now)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, id, kind, note, at }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return addInteraction(board, project, id, { kind, note, at });
  })
);

server.registerTool(
  "update_lead_location",
  {
    title: "Update a lead's location",
    description: "Set a lead's coordinates (lat/lng) and/or city, so it maps correctly and falls into the right areas.",
    inputSchema: {
      project: z.string(),
      id: z.string().describe("Lead id, e.g. L3."),
      lat: z.coerce.number().optional(),
      lng: z.coerce.number().optional(),
      city: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, id, lat, lng, city }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return updateLeadLocation(board, project, id, { lat, lng, city });
  })
);

server.registerTool(
  "customer_portal",
  {
    title: "Customer portal",
    description:
      "Build a per-customer portal page for a CRM company: their contacts plus the board tickets linked to them (link tickets with link_customer_ticket). Returns self-contained HTML; with save:true it also writes the page into the media gallery as portal-<company>.html and returns its path.",
    inputSchema: {
      project: z.string(),
      company: z.string().describe("Company id (slug) from list_companies."),
      save: z.boolean().optional().default(false).describe("Also save the page to the media gallery."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  tryTool(({ project, company, save }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const r = buildCustomerPortal(board, project, company, (id) => board.getTask(project, id));
    if (save) {
      const saved = saveMedia(board, project, {
        name: `portal-${company}.html`,
        content: r.html,
        title: `${r.name} — Customer Portal`,
        tags: ["portal"],
      });
      const { html, ...summary } = r;
      return { ...summary, saved: saved.relPath };
    }
    return r;
  })
);

server.registerTool(
  "list_contract_templates",
  {
    title: "List contract templates",
    description: "List the standard contract templates (NDA, MSA, SOW, commercial license) with their required fields.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(() => listTemplates())
);

server.registerTool(
  "generate_contract",
  {
    title: "Generate a contract",
    description:
      "Fill a standard contract template with the given fields and return the draft markdown. Optionally auto-fills customer_name from a CRM company, and with save:true writes the draft into the media gallery. Drafts are stamped to review with counsel — not legal advice.",
    inputSchema: {
      project: z.string(),
      template: z.enum(["nda", "msa", "sow", "license"]),
      vars: z.record(z.string()).optional().describe("Template fields, e.g. { provider, effective_date, term }."),
      company: z.string().optional().describe("CRM company id to auto-fill customer_name."),
      save: z.boolean().optional().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, template, vars, company, save }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return generateContract(board, project, { template, vars, company, save });
  })
);

server.registerTool(
  "link_customer_ticket",
  {
    title: "Link a ticket to a customer",
    description:
      "Link a board ticket (feature/bug) to a CRM company, stored on the company so it shows in its customer_portal. De-duplicated.",
    inputSchema: {
      project: z.string(),
      company: z.string().describe("Company id (slug)."),
      ticket: z.string().describe("Board ticket id, e.g. FBMCPF-47."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, company, ticket }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return linkTicket(board, project, company, ticket);
  })
);

server.registerTool(
  "unlink_customer_ticket",
  {
    title: "Unlink a ticket from a customer",
    description: "Remove a ticket link from a CRM company.",
    inputSchema: { project: z.string(), company: z.string(), ticket: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, company, ticket }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return unlinkTicket(board, project, company, ticket);
  })
);

server.registerTool(
  "ticket_customers",
  {
    title: "Customers linked to a ticket",
    description: "Reverse lookup: which CRM companies a board ticket is linked to (surfaces the ticket↔customer relationship).",
    inputSchema: { project: z.string(), ticket: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, ticket }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return companiesForTicket(board, project, ticket);
  })
);

server.registerTool(
  "company_priority_tickets",
  {
    title: "A company's tickets by priority",
    description: "List a company's linked board tickets, split into features and bugs and ranked by priority (highest first, i.e. lowest number). Uses the ticket\u2194customer links; reports any linked ids no longer on the board as missing.",
    inputSchema: { project: z.string(), company: z.string().describe("Company id (slug).") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, company }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return companyPriorityTickets(board, project, company, (id) => board.getTask(project, id));
  })
);

server.registerTool(
  "report_company_bug",
  {
    title: "Log a company-reported bug",
    description: "Log a bug reported by a company: creates a board bug (FBB-###), links it to the company, and records the report on the company. Ties customer reports to the bug workflow.",
    inputSchema: {
      project: z.string(),
      company: z.string().describe("Company id (slug)."),
      title: z.string(),
      description: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, company, title, description }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return reportCompanyBug(board, project, company, { title, description }, { logBug: (f) => board.addTask(project, "bug", withOrchestrationLabels("bug", f)) });
  })
);

server.registerTool(
  "resolve_company_bug",
  {
    title: "Resolve a company-reported bug",
    description: "Mark a company-reported bug resolved: sets the board bug to Done and flips the company's report entry to resolved.",
    inputSchema: {
      project: z.string(),
      company: z.string().describe("Company id (slug)."),
      ticket: z.string().describe("The board bug ticket (FBB-###) the company reported."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, company, ticket }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return resolveCompanyBug(board, project, company, ticket, { setStatus: (t, st) => board.setStatus(project, t, st, "Resolved (customer-reported)") });
  })
);

server.registerTool(
  "add_company_agreement",
  {
    title: "Add a company contract/license",
    description:
      "Record a contract or license on a CRM company (stored on the company, alongside contacts). kind 'contract' or 'license'; optional template (from generate_contract), title, value, seats, term, expiresAt, status, notes. Returns the new agreement.",
    inputSchema: {
      project: z.string(),
      company: z.string().describe("Company id (slug)."),
      kind: z.enum(["contract", "license"]),
      template: z.string().optional(),
      title: z.string().optional(),
      value: z.number().optional(),
      seats: z.number().optional(),
      term: z.string().optional(),
      expiresAt: z.string().optional().describe("YYYY-MM-DD"),
      status: z.string().optional(),
      notes: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, company, kind, template, title, value, seats, term, expiresAt, status, notes }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return addAgreement(board, project, company, { kind, template, title, value, seats, term, expiresAt, status, notes });
  })
);

server.registerTool(
  "update_company_agreement",
  {
    title: "Update/extend a company agreement",
    description: "Update a company contract/license by id — e.g. extend a license (new expiresAt), change status ('signed'/'renewed'/'expired'), seats, term, or value.",
    inputSchema: {
      project: z.string(),
      company: z.string(),
      id: z.string().describe("Agreement id (from get_company)."),
      status: z.string().optional(),
      expiresAt: z.string().optional(),
      seats: z.number().optional(),
      term: z.string().optional(),
      value: z.number().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, company, id, status, expiresAt, seats, term, value }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return updateAgreement(board, project, company, id, { status, expiresAt, seats, term, value });
  })
);

server.registerTool(
  "remove_company_agreement",
  {
    title: "Remove a company agreement",
    description: "Delete a contract/license from a company by id.",
    inputSchema: { project: z.string(), company: z.string(), id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, company, id }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return removeAgreement(board, project, company, id);
  })
);

// Bookings / scheduling against CRM contacts (FBMCPF-84) --------------------

server.registerTool(
  "book_meeting",
  {
    title: "Book a call/demo with a CRM contact",
    description:
      "Schedule a call, demo, or meeting with a CRM company (and optionally a specific contact within it). Validates the company exists (list_companies) and the contact belongs to it. Time is an ISO timestamp; stored under crm/bookings.json with status 'scheduled'.",
    inputSchema: {
      project: z.string(),
      company: z.string().describe("CRM company id (from list_companies)."),
      at: z.string().describe("Start time as an ISO timestamp, e.g. 2026-08-01T17:00:00Z."),
      contact: z.string().optional().describe("A contact id (c1) or name within the company."),
      type: z.enum(["call", "demo", "meeting", "onboarding", "other"]).optional(),
      durationMins: z.number().optional().describe("Length in minutes (default 30)."),
      subject: z.string().optional(),
      notes: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, company, at, contact, type, durationMins, subject, notes }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return book(board, project, { company, at, contact, type, durationMins, subject, notes });
  })
);

server.registerTool(
  "cancel_booking",
  {
    title: "Cancel a booking",
    description: "Cancel a scheduled booking by id (from list_bookings), optionally with a reason. Idempotent: cancelling an already-cancelled booking is a no-op.",
    inputSchema: {
      project: z.string(),
      id: z.string().describe("Booking id, e.g. b1."),
      reason: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, id, reason }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return cancelBooking(board, project, id, { reason });
  })
);

server.registerTool(
  "list_bookings",
  {
    title: "List bookings",
    description: "List bookings for the board, newest-first. Filter by company or status ('scheduled'/'cancelled'), or pass upcoming:true for scheduled future bookings sorted soonest-first.",
    inputSchema: {
      project: z.string(),
      company: z.string().optional(),
      status: z.enum(["scheduled", "cancelled"]).optional(),
      upcoming: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  tryTool(({ project, company, status, upcoming }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listBookings(board, project, { company, status, upcoming });
  })
);

}
