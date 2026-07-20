// Auto-extracted from server/index.js (FBMCPF-224). Registration blocks moved verbatim.
export function registerLicensingTools(server, ctx) {
  const { DATA_DIR, checkUpdates, license, registerEmail, tryTool, z } = ctx;

// licensing ----------------------------------------------------------------

server.registerTool(
  "license_status",
  {
    title: "License status",
    description:
      "Report the current licensing state: usage tier, whether writes are allowed, and (for a commercial trial) time remaining. Call this if a write was blocked, or during onboarding.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(() => {
    const ev = license.evaluate(DATA_DIR);
    return {
      ...ev,
      pricing: { perSeatPerYearUSD: license.PRICE_PER_SEAT_YEAR_USD, checkoutUrl: license.CHECKOUT_URL },
      contact: { url: license.LICENSE_CONTACT_URL, email: license.LICENSE_CONTACT_EMAIL },
    };
  })
);

server.registerTool(
  "set_usage_type",
  {
    title: "Set usage type (onboarding)",
    description:
      "Record how FeatureBoard is being used. 'personal' = private non-commercial (free). 'public' = public/open-source/nonprofit non-commercial (free). 'commercial-trial' = start a free 24-hour commercial evaluation (writes freeze after 24h). 'commercial' = commercial use (requires a license key via activate_license). Ask the user which applies before setting.",
    inputSchema: {
      type: z.enum(["personal", "public", "commercial-trial", "commercial"]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  tryTool(({ type }) => {
    license.setUsageType(DATA_DIR, type);
    return license.evaluate(DATA_DIR);
  })
);

server.registerTool(
  "activate_license",
  {
    title: "Activate license key",
    description:
      "Activate a commercial license. Two modes — provide exactly one: (1) `key`, a signed license key string pasted " +
      "from the licensor; or (2) `email` + `orderId` from your purchase receipt, in which case the server fetches the " +
      "signed key for you from the featureboard.ai claim API (a single outbound HTTPS POST carrying just that email + " +
      "order id) and then verifies it exactly the same way as a pasted key. Either way, verification itself is fully " +
      "offline. Unblocks writes for commercial use.",
    inputSchema: {
      key: z.string().optional().describe("The signed license key string (pasted-key mode). Omit if using email + orderId."),
      email: z.string().optional().describe("Receipt email from your purchase (activation-by-order mode). Requires orderId; omit if passing key."),
      orderId: z.string().optional().describe("Order id from your purchase receipt (activation-by-order mode). Requires email; omit if passing key."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  tryTool(async ({ key, email, orderId }) => {
    const hasKey = typeof key === "string" && key.trim().length > 0;
    const hasEmail = typeof email === "string" && email.trim().length > 0;
    const hasOrderId = typeof orderId === "string" && orderId.trim().length > 0;
    const orderMode = hasEmail || hasOrderId;

    if (hasKey && orderMode) {
      throw new Error("Provide either a license key, or email + orderId to claim one — not both.");
    }
    if (!hasKey && !orderMode) {
      throw new Error("Provide either a license key, or email + orderId to claim one.");
    }
    if (orderMode && !(hasEmail && hasOrderId)) {
      throw new Error("Activation by order requires BOTH email and orderId.");
    }

    let resolvedKey = key;
    if (orderMode) {
      const claim = await license.fetchKeyByOrder({ email, orderId });
      resolvedKey = claim.key;
    }

    license.activate(DATA_DIR, resolvedKey);
    const ev = license.evaluate(DATA_DIR);
    return { activated: true, ...ev };
  })
);

server.registerTool(
  "request_commercial_license",
  {
    title: "Request a commercial license",
    description:
      "Start the commercial licensing process. Records the request locally (for the licensor's CRM) and returns the licensing URL and email to complete a signed agreement. After the licensor issues a key, use activate_license.",
    inputSchema: {
      name: z.string().describe("Your name / point of contact."),
      email: z.string().describe("Contact email."),
      company: z.string().describe("Company / organization name."),
      seats: z.number().int().optional().describe("Approximate number of seats needed."),
      notes: z.string().optional().describe("Anything else the licensor should know."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  tryTool(({ name, email, company, seats, notes }) => {
    const entry = license.recordRequest(DATA_DIR, { name, email, company, seats, notes });
    const subject = encodeURIComponent(`FeatureBoard commercial license — ${company}`);
    const body = encodeURIComponent(
      `Company: ${company}\nContact: ${name} <${email}>\nSeats: ${seats || "?"}\nRequest id: ${entry.id}\n\n${notes || ""}`
    );
    return {
      recorded: entry,
      next_steps:
        "Your request was recorded. Fastest path: buy self-serve at the checkout URL below and activate the emailed key with activate_license. For POs/enterprise terms, use the licensing URL or email instead and the licensor will issue a key after signature.",
      buy_now: { url: license.CHECKOUT_URL, pricePerSeatPerYearUSD: license.PRICE_PER_SEAT_YEAR_USD },
      licensing_url: license.LICENSE_CONTACT_URL,
      email_to: license.LICENSE_CONTACT_EMAIL,
      mailto: `mailto:${license.LICENSE_CONTACT_EMAIL}?subject=${subject}&body=${body}`,
    };
  })
);

server.registerTool(
  "register_email",
  {
    title: "Register onboarding email (optional)",
    description:
      "Store an email address the user explicitly typed and submitted on the tier-picker onboarding screen (the 'Save email' action — separate from picking a usage tier), then POST it once to the featureboard.ai registrations listener. This is deliberate outbound egress: the board is otherwise local-only, and this is the only call it makes without a user-configured destination (contrast notify_slack, which requires a webhook the user pastes in). There is no usage telemetry — only this email, and only after explicit submit. Never call this speculatively (e.g. on every onboarding render, or with an unconfirmed/autofilled value); omit or pass an empty string to skip. No-ops (no local write, no network call) when email is empty or malformed. Safe to call again later — once posted, it will not re-POST.",
    inputSchema: {
      email: z.string().describe("Email address the user explicitly typed and submitted. Omit/empty to skip registration."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  tryTool(({ email }) => registerEmail(DATA_DIR, email))
);

// updates (FBMCPF-260) ------------------------------------------------------

server.registerTool(
  "check_updates",
  {
    title: "Check for FeatureBoard updates",
    description:
      "Explicitly check featureboard.ai for a newer FeatureBoard release. This makes exactly ONE outbound HTTPS " +
      "GET request — to https://featureboard.ai/downloads/latest.json — and ONLY when you call this tool; it " +
      "never runs automatically (no polling, no startup check, no background timer). It is a plain GET with no " +
      "request body: nothing about you, your board, or this machine is sent. Compares the manifest's version " +
      "against THIS running server's own version (read from its own package.json) and reports whether an update " +
      "is available, plus both download links — featureboard.plugin for Claude/Cowork installs, " +
      "featureboard-mcp.zip for Cursor/Grok Build/other MCP clients. Fails soft on any network problem (timeout, " +
      "offline, bad response) — never throws; call it again later if it couldn't reach the server.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  tryTool(() => checkUpdates())
);

}
