// Auto-extracted from server/index.js (FBMCPF-224). Registration blocks moved verbatim.
export function registerSiteTools(server, ctx) {
  const { addPage, addRawPage, applySiteTemplate, autoConfigureAnalytics, commitFeature, createCampaign, draftEmail, editSection, getBoard, getCampaign, getEmail, getMedia, getPackagingConfig, getSite, getSiteTraffic, listAssets, listCampaigns, listMail, listPages, listSiteTemplates, markSent, maybeLint, meta, recordOpen, removePage, renderSite, saveAsset, savePackagingConfig, scaffoldSite, setAnalyticsConfig, setLoginGate, setPageSeo, setSite, setSiteAnalytics, siteRoot, suggestPackaging, tryTool, validatePackaging, writeTool, z } = ctx;

// Mail ---------------------------------------------------------------------

server.registerTool(
  "draft_email",
  {
    title: "Draft an email",
    description:
      "Compose and save an email draft in the project mail center (does not send — there is no mail connector; the user or a future connector sends). Recipients are validated. Optionally tie it to a CRM company. When the project config voiceLint is on, the body text is scored for AI-writing tells and the result is attached as `voice` (warn-only, never blocks the draft).",
    inputSchema: {
      project: z.string(),
      to: z.union([z.string(), z.array(z.string())]).describe("Recipient address(es)."),
      subject: z.string().optional(),
      body: z.string().optional(),
      cc: z.union([z.string(), z.array(z.string())]).optional(),
      company: z.string().optional().describe("Related CRM company id."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, to, subject, body, cc, company }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const result = draftEmail(board, project, { to, subject, body, cc, company });
    // FBMCPF-268: warn-only voice-lint self-check (opt-in via project config voiceLint).
    const voice = maybeLint(board, project, body);
    if (voice) result.voice = voice;
    return result;
  })
);

server.registerTool(
  "list_mail",
  {
    title: "List mail",
    description: "List mail (newest-first), optionally filtered by status (draft/sent) and/or company. Sent items form the mail history.",
    inputSchema: {
      project: z.string(),
      status: z.enum(["draft", "sent"]).optional(),
      company: z.string().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, status, company }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listMail(board, project, { status, company });
  })
);

server.registerTool(
  "get_email",
  {
    title: "Get an email",
    description: "Full email message by id (from list_mail).",
    inputSchema: { project: z.string(), id: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, id }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return getEmail(board, project, id);
  })
);

server.registerTool(
  "mark_email_sent",
  {
    title: "Mark an email sent",
    description:
      "Record that a draft was sent (moves it into mail history with a sentAt timestamp). Does not actually send — tracking only.",
    inputSchema: { project: z.string(), id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, id }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return markSent(board, project, id);
  })
);

// Marketing campaigns ------------------------------------------------------

server.registerTool(
  "create_campaign",
  {
    title: "Create a marketing campaign",
    description:
      "Create a marketing campaign with a recipient list and a send batch size. Recipients are validated + de-duplicated; sending is left to the user/a connector (this tracks the campaign and computes send batches). Returns the campaign + stats. When the project config voiceLint is on, the body copy is scored for AI-writing tells and the result is attached as `voice` (warn-only, never blocks the draft).",
    inputSchema: {
      project: z.string(),
      name: z.string(),
      recipients: z.array(z.string()).describe("Recipient email addresses."),
      subject: z.string().optional(),
      body: z.string().optional(),
      batchSize: z.number().int().min(1).optional().describe("Max recipients per send batch (default 50)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, recipients, subject, body, batchSize }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const result = createCampaign(board, project, { name, recipients, subject, body, batchSize });
    // FBMCPF-268: warn-only voice-lint self-check (opt-in via project config voiceLint).
    const voice = maybeLint(board, project, body);
    if (voice) result.voice = voice;
    return result;
  })
);

server.registerTool(
  "list_campaigns",
  {
    title: "List campaigns",
    description: "List marketing campaigns (newest-first) with summary stats (recipients, opens, open rate, batch count).",
    inputSchema: { project: z.string(), status: z.enum(["draft", "scheduled", "sent"]).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, status }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listCampaigns(board, project, { status });
  })
);

server.registerTool(
  "get_campaign",
  {
    title: "Get a campaign",
    description: "Full campaign incl. recipients, open stats, and the send-batch sizes.",
    inputSchema: { project: z.string(), id: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, id }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return getCampaign(board, project, id);
  })
);

server.registerTool(
  "record_campaign_open",
  {
    title: "Record a campaign open",
    description:
      "Record that a recipient opened a campaign (idempotent per recipient) — for when a mail connector or manual entry reports opens. Updates open-rate stats.",
    inputSchema: { project: z.string(), id: z.string(), email: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, id, email }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return recordOpen(board, project, id, email);
  })
);

// Website ------------------------------------------------------------------

server.registerTool(
  "get_site",
  {
    title: "Get the project website",
    description: "Read the project's splash/website config (title, tagline, theme, sections, login gate). Returns defaults if none built yet.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return getSite(board, project);
  })
);

server.registerTool(
  "set_site",
  {
    title: "Build/update the project website",
    description:
      "Set the project's splash site (title, tagline, theme light/dark, and sections). Re-renders site/index.html. Only provided fields change.",
    inputSchema: {
      project: z.string(),
      title: z.string().optional(),
      tagline: z.string().optional(),
      theme: z.enum(["light", "dark"]).optional(),
      sections: z.array(z.object({ heading: z.string(), body: z.string() })).optional(),
      seo: z.object({ description: z.string().optional(), image: z.string().optional(), ogTitle: z.string().optional(), ogDescription: z.string().optional(), ogType: z.string().optional() }).optional().describe("Home-page SEO: meta description + Open Graph tags."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, title, tagline, theme, sections, seo }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return setSite(board, project, { title, tagline, theme, sections, seo });
  })
);

server.registerTool(
  "scaffold_site",
  {
    title: "Scaffold a whole website from one spec",
    description:
      "Generate a whole site in one shot from a single spec instead of set_site field-by-field: sets the home page (title, tagline, theme, sections) and creates each initial sub-page. Persisted through the website store and rendered to the site location (<project>/site/ by default, or the project's websiteLocation when set). Pass initGit:true to give the scaffolded site its own git repo (git init + a first \"site: scaffold\" commit) when it is not already inside one — the repo path is returned. Pair with the generate_site prompt, which has Claude produce the spec.",
    inputSchema: {
      project: z.string(),
      title: z.string().describe("Site / home page title."),
      tagline: z.string().optional(),
      theme: z.enum(["light", "dark"]).optional(),
      sections: z.array(z.object({ heading: z.string(), body: z.string() })).optional().describe("Home page sections."),
      pages: z
        .array(
          z.object({
            slug: z.string(),
            title: z.string().optional(),
            sections: z.array(z.object({ heading: z.string(), body: z.string() })).optional(),
          })
        )
        .optional()
        .describe("Initial sub-pages to create."),
      initGit: z.boolean().optional().describe("Give the scaffolded site its own git repo (git init + first commit) when it isn't already inside one."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, title, tagline, theme, sections, pages, initGit }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return scaffoldSite(board, project, { title, tagline, theme, sections, pages }, { initGit });
  })
);

server.registerTool(
  "edit_site_section",
  {
    title: "Edit a website section",
    description:
      "Live editor: patch one website section by index (heading and/or body), or append a new section when index is omitted. Re-renders the page.",
    inputSchema: {
      project: z.string(),
      index: z.number().int().optional().describe("Section index to patch; omit to append."),
      heading: z.string().optional(),
      body: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, index, heading, body }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return editSection(board, project, { index, heading, body });
  })
);

server.registerTool(
  "add_page",
  {
    title: "Add/update a website page",
    description:
      "Add or update a sub-page of the project site (rendered to site/<slug>.html), with its own title and sections. The home page stays managed by set_site. Re-renders all pages so theme/gate stay consistent.",
    inputSchema: {
      project: z.string(),
      slug: z.string().describe("URL slug for the page, e.g. 'about' → site/about.html."),
      title: z.string().optional(),
      sections: z.array(z.object({ heading: z.string(), body: z.string() })).optional(),
      seo: z.object({ description: z.string().optional(), image: z.string().optional(), ogTitle: z.string().optional(), ogDescription: z.string().optional(), ogType: z.string().optional() }).optional().describe("Per-page SEO: meta description + Open Graph tags."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, slug, title, sections, seo }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return addPage(board, project, { slug, title, sections, seo });
  })
);

server.registerTool(
  "set_page_seo",
  {
    title: "Set a page's SEO metadata",
    description: "Set SEO for the home page (omit slug, or slug='index') or a sub-page: meta description, Open Graph title/description/type, and image. Re-renders the page. Merges over existing SEO.",
    inputSchema: {
      project: z.string(),
      slug: z.string().optional().describe("Sub-page slug, or omit / 'index' for the home page."),
      description: z.string().optional(),
      image: z.string().optional().describe("Absolute URL or assets/<file> path for og:image."),
      ogTitle: z.string().optional(),
      ogDescription: z.string().optional(),
      ogType: z.string().optional().describe("Open Graph type, e.g. website, article."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, slug, description, image, ogTitle, ogDescription, ogType }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return setPageSeo(board, project, { slug, description, image, ogTitle, ogDescription, ogType });
  })
);

server.registerTool(
  "list_site_templates",
  {
    title: "List starter site templates",
    description: "List the available starter website templates (landing, docs, blog) the builder can start from.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(() => listSiteTemplates())
);

server.registerTool(
  "apply_site_template",
  {
    title: "Start the site from a template",
    description: "Seed the project website from a starter template (landing, docs, blog): sets title/tagline/theme/sections and any starter pages, then renders. Replaces the current site config — use set_site/add_page to refine after.",
    inputSchema: {
      project: z.string(),
      template: z.enum(["landing", "docs", "blog"]),
      title: z.string().optional().describe("Override the site title (defaults to the template's placeholder)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, template, title }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const res = applySiteTemplate(board, project, template, { title });
    const brand = meta.brandContext(board, project);
    let brandApplied = false;
    if (brand.hasBrand && (brand.primary || brand.accent || brand.font)) {
      setSite(board, project, {
        colors: { primary: brand.primary || undefined, accent: brand.accent || undefined },
        font: brand.font || undefined,
      });
      brandApplied = true;
    }
    return { ...res, brandApplied };
  })
);

server.registerTool(
  "list_pages",
  {
    title: "List website pages",
    description: "List the site's pages: the home page (site/index.html) plus each sub-page with its slug, title, and file.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listPages(board, project);
  })
);

server.registerTool(
  "remove_page",
  {
    title: "Remove a website page",
    description: "Delete a sub-page (by slug) and its rendered file. The home page can't be removed this way.",
    inputSchema: { project: z.string(), slug: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, slug }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return removePage(board, project, slug);
  })
);

server.registerTool(
  "deploy_site",
  {
    title: "Deploy the website",
    description:
      "Re-render the project's site and publish it by committing (and optionally pushing) it through the git integration — the MCP equivalent of the old website deploy. The site lives at <project>/site/ by default, or at the project's websiteLocation when set (a shipped site outside the pad, in its own repo — see set_project_config). When websiteLocation / gitTargets.websiteRepo is configured the commit runs in that website repo; otherwise it runs where the pad site lives. Requires git integration enabled (set_git_config); no-ops with a reason otherwise. When push is omitted, the effective push behavior is resolved from gitMode the same way as commit_feature (project override, else account-wide default, else \"commit-only\"); \"ask\" never pushes silently. Runs on this machine using its git credentials.",
    inputSchema: {
      project: z.string(),
      message: z.string().optional().describe("Custom deploy commit message."),
      push: z.boolean().optional().describe("Override the resolved gitMode for this deploy (always wins over gitMode)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  writeTool(({ project, message, push }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const rendered = renderSite(board, project);
    // FBMCPF-249: when a shipped-website repo is configured (websiteLocation or an
    // explicit gitTargets.websiteRepo), run the git steps there; otherwise behave
    // exactly as before (commit where the pad's code/site lives).
    const targets = meta.resolveGitTargets(board, project);
    const websiteRepoPath = targets.websiteRepo && targets.websiteRepo.path ? targets.websiteRepo.path : null;
    const gitOpts = websiteRepoPath
      ? { cwd: siteRoot(board, project), repoOverride: websiteRepoPath }
      : { cwd: siteRoot(board, project) };
    const deploy = commitFeature(
      board,
      project,
      { title: `Deploy ${project} site`, message, push },
      gitOpts
    );
    return { rendered, deploy };
  })
);

server.registerTool(
  "upload_site_asset",
  {
    title: "Upload a website asset",
    description:
      "Store an image/asset under the site's assets/ folder (base64 by default, or utf8 text). Returns a ref like 'assets/logo.png' to use in page sections. Name must be a plain filename with an extension.",
    inputSchema: {
      project: z.string(),
      name: z.string().describe("Filename with extension, e.g. logo.png."),
      content: z.string().describe("Asset bytes: base64 (default) or utf8 text."),
      encoding: z.enum(["base64", "utf8"]).optional().default("base64"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, content, encoding }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return saveAsset(board, project, { name, content, encoding });
  })
);

server.registerTool(
  "list_site_assets",
  {
    title: "List website assets",
    description: "List the assets stored under the site's assets/ folder (name, ref, size).",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listAssets(board, project);
  })
);

server.registerTool(
  "set_site_analytics",
  {
    title: "Configure site analytics",
    description:
      "Add an analytics snippet to every page of the site's <head>: Plausible or Google Analytics by id, or a raw custom <script>. Re-renders the site. Set enabled:false to remove it.",
    inputSchema: {
      project: z.string(),
      provider: z.enum(["plausible", "ga", "ga4", "custom"]).optional(),
      id: z.string().optional().describe("Plausible domain or GA measurement id (e.g. G-XXXX)."),
      snippet: z.string().optional().describe("Raw <script> for provider 'custom'."),
      enabled: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, provider, id, snippet, enabled }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return setSiteAnalytics(board, project, { provider, id, snippet, enabled });
  })
);

// external site analytics: config + auto-configure + read proxy (FBMCPF-83) -----

server.registerTool(
  "set_analytics_config",
  {
    title: "Configure external analytics",
    description:
      "Configure which external analytics provider to READ site traffic from (distinct from set_site_analytics, which injects tracking). Provider is plausible/umami/custom (Google Analytics needs an OAuth connector). No API key is stored — the read proxy reads it from the FEATUREBOARD_ANALYTICS_KEY env var. Set enabled:false to turn the proxy off.",
    inputSchema: {
      project: z.string(),
      provider: z.enum(["plausible", "umami", "ga", "custom"]).optional(),
      siteId: z.string().optional().describe("Plausible domain, umami website id, etc."),
      host: z.string().optional().describe("API host (e.g. plausible.io, or your self-hosted umami URL)."),
      statsUrl: z.string().optional().describe("For provider 'custom': the full stats endpoint ({period} is substituted)."),
      metrics: z.array(z.string()).optional().describe("Metrics to request, e.g. visitors, pageviews, bounce_rate."),
      period: z.string().optional().describe("Default window, e.g. 7d, 30d, month."),
      enabled: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, provider, siteId, host, statsUrl, metrics, period, enabled }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return setAnalyticsConfig(board, project, { provider, siteId, host, statsUrl, metrics, period, enabled });
  })
);

server.registerTool(
  "auto_configure_analytics",
  {
    title: "Auto-configure external analytics",
    description:
      "Derive the external analytics read config from the site's existing tracking settings (set_site_analytics), so you don't retype the domain/property, and enable the proxy. Errors if the site has no analytics configured yet.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return autoConfigureAnalytics(board, project);
  })
);

server.registerTool(
  "get_site_traffic",
  {
    title: "Get site traffic (analytics proxy)",
    description:
      "Read proxy for site traffic: fetch the configured provider's stats (Plausible/umami) using the FEATUREBOARD_ANALYTICS_KEY env var and return normalised numbers so the board can show traffic. Degrades gracefully — when disabled, unconfigured, or missing a key it returns the exact request URL so you can fetch it yourself.",
    inputSchema: {
      project: z.string(),
      period: z.string().optional().describe("Override the configured window, e.g. 7d, 30d."),
      metrics: z.array(z.string()).optional().describe("Override the configured metrics list."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  tryTool(async ({ project, period, metrics }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return getSiteTraffic(board, project, { period, metrics });
  })
);

// AI-assisted packaging config (FBMCPF-85) ---------------------------------

server.registerTool(
  "suggest_packaging",
  {
    title: "Suggest packaging metadata",
    description:
      "AI-gen seed: derive a draft of the .mcpb packaging metadata (name, displayName, description, keywords) from the project's config, brand, and products. Returns a draft to refine — it does NOT save. Refine it, then persist with save_packaging_config.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return suggestPackaging(board, project);
  })
);

server.registerTool(
  "save_packaging_config",
  {
    title: "Save packaging config",
    description:
      "Persist the .mcpb packaging metadata for a project (packaging.json): name (slugified), displayName, description, longDescription, keywords, version. Validated by the same rules the build preflight uses; rejects hard errors (missing name/description). Only provided fields change.",
    inputSchema: {
      project: z.string(),
      name: z.string().optional(),
      displayName: z.string().optional(),
      description: z.string().optional(),
      longDescription: z.string().optional(),
      keywords: z.array(z.string()).optional(),
      version: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, name, displayName, description, longDescription, keywords, version }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return savePackagingConfig(board, project, { name, displayName, description, longDescription, keywords, version });
  })
);

server.registerTool(
  "validate_packaging",
  {
    title: "Validate packaging metadata",
    description:
      "Run the build-preflight packaging checks against the project's saved packaging.json: reports hard errors (missing/invalid name or description) and advisory warnings (no keywords, missing displayName/longDescription).",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const config = getPackagingConfig(board, project);
    return { project, config, validation: validatePackaging(config) };
  })
);

server.registerTool(
  "publish_media_to_site",
  {
    title: "Publish a media asset to the site",
    description:
      "Publish a gallery asset as a page on the project site (media/push-to-blog). A report/HTML/text asset becomes the page's content; an image is copied to site/assets and shown on the page. Returns the new page. Links media → website.",
    inputSchema: {
      project: z.string(),
      name: z.string().describe("Gallery asset filename (from list_media)."),
      slug: z.string().optional().describe("Page slug; defaults to the asset name."),
      title: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, slug, title }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    const et = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const asset = getMedia(board, project, name, { withContent: true });
    const pageSlug = slug || name.replace(/\.[^.]+$/, "");
    const pageTitle = title || asset.title || name;
    let html;
    if (asset.kind === "image") {
      const saved = saveAsset(board, project, { name, content: asset.content, encoding: "base64" });
      html =
        `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${et(pageTitle)}</title></head>` +
        `<body style="margin:0;text-align:center;background:#faf9f5"><img src="${saved.ref}" alt="${et(pageTitle)}" style="max-width:100%;height:auto"></body></html>`;
    } else {
      const c = String(asset.content || "");
      html = /<!doctype|<html/i.test(c)
        ? c
        : `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
          `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${et(pageTitle)}</title></head><body>${c}</body></html>`;
    }
    const page = addRawPage(board, project, { slug: pageSlug, title: pageTitle, html });
    return { published: page.slug, path: page.path, from: name, kind: asset.kind };
  })
);

server.registerTool(
  "enable_login_gate",
  {
    title: "Enable the site login gate",
    description:
      "Turn on an optional passcode gate for the project's hosted site. NOTE: this is a soft client-side gate (the passcode ships in the page) — casual gating, NOT real authentication; real auth needs a hosting layer. Requires a passcode.",
    inputSchema: {
      project: z.string(),
      passcode: z.string().describe("Passcode visitors must enter."),
      message: z.string().optional().describe("Prompt shown to visitors."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project, passcode, message }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return setLoginGate(board, project, { enabled: true, passcode, message });
  })
);

server.registerTool(
  "disable_login_gate",
  {
    title: "Disable the site login gate",
    description: "Turn off the project site's passcode gate and re-render the page without it.",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  writeTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return setLoginGate(board, project, { enabled: false });
  })
);

}
