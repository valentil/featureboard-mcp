// Auto-extracted from server/index.js (FBMCPF-224). Registration blocks moved verbatim.
export function registerPrompts(server, ctx) {
  const { Board, platformLimit, tryBrand, tryImageTool, z } = ctx;

// prompts -------------------------------------------------------------------

// A one-click "turn this chat into a project". Claude already has the whole
// conversation in context, so the prompt just directs it to mine the chat and
// persist the result via plan_work.
server.registerPrompt(
  "project_from_chat",
  {
    title: "Turn this chat into a project",
    description:
      "Analyze the current conversation and create a FeatureBoard project from it — a project name plus features (new work) and bugs (issues raised).",
    argsSchema: {
      name: z
        .string()
        .optional()
        .describe("Optional project name. If omitted, propose one from the chat."),
    },
  },
  ({ name } = {}) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "Turn our conversation so far into a FeatureBoard project.\n\n" +
            (name
              ? `Use the project name: "${name}".\n`
              : "1. Propose a short, clear project name based on what we discussed.\n") +
            "2. Read back through this chat and extract the concrete work:\n" +
            "   - features = new capabilities, tasks, or ideas to build\n" +
            "   - bugs = problems, defects, regressions, or issues raised\n" +
            "3. Call plan_work once with createProject:true to create the project and add those features and bugs. Keep titles short; put detail in each description. Where a chat item maps to an outside id, set its ref.\n" +
            "4. If this project will use git integration (set_git_config with a codeLocation), ask how I want finished tickets pushed: commit only (never push automatically), commit + push every time, or ask each time before pushing. Record the answer with set_git_config's gitMode for this project (or set_global_config's gitMode if I say it should apply to every project). Skip this if git integration isn't relevant here.\n" +
            "5. Show me the created tickets grouped by feature/bug.\n\n" +
            "If the scope is large or ambiguous, show me the proposed name and breakdown and let me adjust before you create anything.",
        },
      },
    ],
  })
);

server.registerPrompt(
  "process_next",
  {
    title: "Process the next ticket",
    description:
      "Pull the top ticket off the board's priority queue and work it end-to-end with the FeatureBoard work-packet loop.",
    argsSchema: {
      project: z.string().optional().describe("Board to work. If omitted, ask or infer."),
      continuous: z.string().optional().describe("'yes' to keep going through the queue until it's empty."),
    },
  },
  ({ project, continuous } = {}) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Work the FeatureBoard queue${project ? ` for project "${project}"` : ""} using the work-packet loop:\n` +
            "1. Call next_task to get the top open ticket (honours priority). If none, tell me the queue is clear and stop.\n" +
            "2. set_status the ticket to \"In Progress\".\n" +
            "3. Call get_work_packet for it. Read the files it points to at the code location — do not dump whole files into context.\n" +
            "4. Do the work. If it's a substantial or code ticket, dispatch it to a fresh sub-agent with the packet so it gets isolated context — at the model from the ticket's model: label (sonnet/haiku may run in parallel; opus/fable sequentially with review), with rigor matched to its effort: label. Do trivial tickets inline. Tell the sub-agent to call log_heartbeat a few times at milestones during longer dispatches so get_agent_monitor shows live progress instead of a blank wait. Only you (the orchestrator) write to the board.\n" +
            "5. Verify the change — run it or its tests where relevant.\n" +
            "6. set_status Done with a one-line completionSummary, and log_work with additions/deletions (and the model used).\n" +
            "7. If git is configured for the project, commit the change now — one commit per ticket, message referencing the ticket id (commit_feature or git commit). Don't pass push explicitly unless I've told you to; commit_feature resolves the project's/account's gitMode on its own, and if it comes back with a note (gitMode \"ask\"), check with me before calling it again with push:true.\n" +
            (continuous === "yes"
              ? "8. Repeat from step 1 until the queue is empty, but pause to check in with me on anything ambiguous, risky, or destructive before proceeding."
              : "8. Then stop and report what you did and what's next in the queue."),
        },
      },
    ],
  })
);

server.registerPrompt(
  "generate_media",
  {
    title: "Generate a shareable report/image",
    description:
      "Generate a shareable web report (or image) for a goal and save it into the project's media/ gallery via save_media.",
    argsSchema: {
      project: z.string().optional().describe("Board whose media/ folder to save into."),
      goal: z.string().optional().describe("What the report/image should show."),
    },
  },
  ({ project, goal } = {}) => {
    const brand = project ? tryBrand(project) : null;
    return {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Generate a shareable asset${project ? ` for project "${project}"` : ""} and save it to the media gallery.\n\n` +
            (goal ? `Goal: ${goal}\n\n` : "1. Ask me what the asset should show if it isn't clear.\n") +
            (brand && brand.hasBrand ? brand.instruction + "\n\n" : "") +
            "Steps:\n" +
            "- Check list_references for any uploaded reference images (media/uploads/) and work from them if present.\n" +
            "- Produce a self-contained, shareable HTML report (inline CSS, no external assets) — or an image if that fits better.\n" +
            "- For a real photographic/raster image, prefer the generate_image prompt (it routes through an image tool/connector and falls back to SVG).\n" +
            "- Call save_media with a descriptive filename (e.g. q3-summary.html), the content, a title, the prompt/goal, any tags, and the related ticket if there is one. Use encoding:'base64' for image bytes.\n" +
            "- Confirm what was saved and its media/ path, and mention it will now appear in list_media.",
        },
      },
    ],
    };
  }
);

server.registerPrompt(
  "generate_image",
  {
    title: "Generate a real image into the gallery",
    description:
      "Produce an actual raster image (via an image-generation tool/connector, if one is available) and save it to the project's media/ gallery as base64 — falling back to a self-contained SVG when no image generator is connected.",
    argsSchema: {
      project: z.string().optional().describe("Board whose media/ folder to save into."),
      goal: z.string().optional().describe("What the image should depict."),
      name: z.string().optional().describe("Filename to save as (e.g. hero.png). Defaults from the goal."),
      aspect: z.string().optional().describe("Optional aspect/size hint, e.g. '16:9', '1024x1024'."),
    },
  },
  ({ project, goal, name, aspect } = {}) => {
    const brand = project ? tryBrand(project) : null;
    const imageTool = project ? tryImageTool(project) : null;
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Generate a real image${goal ? ` of: ${goal}` : ""}${project ? ` for project "${project}"` : ""} and save it to the media gallery.\n\n` +
              (goal ? "" : "1. Ask me what the image should depict if it isn't clear.\n") +
              (aspect ? `Aspect/size: ${aspect}\n` : "") +
              (brand && brand.hasBrand ? brand.instruction + "\n\n" : "") +
              "Steps:\n" +
              (imageTool
                ? `- Use the project's configured image tool "${imageTool}" to generate the image. If it isn't available, fall back to any other connected image-generation tool/connector/skill.\n`
                : "- Look for an available image-generation capability — a connected image MCP/connector or an image-gen skill (e.g. 'imagegen'). Use it to generate the image.\n") +
              "- Check list_references first for any uploaded reference images to guide style/subject.\n" +
              "- When you have the image bytes, call save_media with a .png/.jpg name" + (name ? ` (use "${name}")` : "") + ", encoding:'base64', a title, prompt set to the goal, and the related ticket if any. The project's brand words are recorded automatically.\n" +
              "- If NO image generator is available, do NOT fake a raster: instead produce a crisp, self-contained SVG that depicts the goal, save it as a .svg (encoding:'utf8'), and tell me it's a vector fallback — and that real raster generation needs an image tool (set one via set_project_config imageTool, or connect an image generator).\n" +
              "- Confirm what was saved, its media/ path, and that it now appears in list_media.",
          },
        },
      ],
    };
  }
);

server.registerPrompt(
  "generate_variations",
  {
    title: "Generate media variations",
    description:
      "Produce several alternative versions of an asset from one prompt/goal, saved as a group for side-by-side review.",
    argsSchema: {
      project: z.string().optional(),
      goal: z.string().optional().describe("What the asset should show."),
      count: z.string().optional().describe("How many variations (default 3)."),
    },
  },
  ({ project, goal, count } = {}) => {
    const brand = project ? tryBrand(project) : null;
    return {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Generate ${count || "3"} variations${goal ? ` for: ${goal}` : ""}${project ? ` in project "${project}"` : ""}.\n\n` +
            (brand && brand.hasBrand ? brand.instruction + "\n\n" : "") +
            "Steps:\n" +
            "- Pick a short group id (e.g. a slug of the goal).\n" +
            `- Produce ${count || "3"} distinct takes on the goal (vary layout/tone/style).\n` +
            "- Save each with save_media using distinct names (e.g. <group>-1.html, <group>-2.html) and the SAME group id so they're siblings.\n" +
            "- Then call list_variations with that group id and show them side-by-side for the user to pick.",
        },
      },
    ],
    };
  }
);

server.registerPrompt(
  "refine_media",
  {
    title: "Refine a media asset",
    description:
      "Iterate on an existing gallery asset with a follow-up instruction, saving the result as a new version (its history is preserved).",
    argsSchema: {
      project: z.string().optional(),
      name: z.string().optional().describe("Gallery asset to refine."),
      instruction: z.string().optional().describe("How to change/improve it."),
    },
  },
  ({ project, name, instruction } = {}) => {
    const brand = project ? tryBrand(project) : null;
    return {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Refine a media asset${name ? ` ("${name}")` : ""}${project ? ` in project "${project}"` : ""}.\n\n` +
            (instruction ? `Refinement: ${instruction}\n\n` : "1. Ask what to change if it isn't clear.\n") +
            (brand && brand.hasBrand ? brand.instruction + "\n\n" : "") +
            "Steps:\n" +
            "- get_media the asset (and note its existing versions) to see the current content + the prompt it came from.\n" +
            "- Produce the improved version applying the refinement, keeping the original intent.\n" +
            "- Call save_media with the SAME name (this archives the current copy as a prior version automatically) and set prompt to the refinement instruction so the chain is recorded.\n" +
            "- Confirm, and show the version list from get_media so the refinement chain is visible.",
        },
      },
    ],
    };
  }
);

server.registerPrompt(
  "share_media",
  {
    title: "Draft social share copy",
    description:
      "Draft suggested X and LinkedIn copy for a gallery item and save them as reviewable drafts (does not post).",
    argsSchema: {
      project: z.string().optional(),
      asset: z.string().optional().describe("Gallery asset to promote."),
    },
  },
  ({ project, asset } = {}) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Draft social share copy${asset ? ` for "${asset}"` : ""}${project ? ` in project "${project}"` : ""}.\n\n` +
            "Steps:\n" +
            `- Write a short, punchy X post (≤${platformLimit("x")} chars) and a longer, more detailed LinkedIn post.\n` +
            "- Save each with draft_share (platform 'x' and 'linkedin', with the asset).\n" +
            "- Show me both drafts for review. Do NOT post anything — there is no publishing connector; I'll post them myself or wire a connector later.",
        },
      },
    ],
  })
);

server.registerPrompt(
  "generate_site",
  {
    title: "Generate a whole website from one prompt",
    description:
      "From a single description, generate a complete site (title, tagline, theme, home sections, and initial sub-pages) and scaffold it in one shot with scaffold_site, instead of building it field-by-field.",
    argsSchema: {
      project: z.string().optional(),
      brief: z.string().optional().describe("What the site is for (audience, tone, what to include)."),
    },
  },
  ({ project, brief } = {}) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Generate a complete website${project ? ` for project "${project}"` : ""}.\n\n` +
            (brief ? `Brief: ${brief}\n\n` : "1. If the brief isn't clear, ask me a couple of quick questions first (audience, tone, pages).\n\n") +
            "Steps:\n" +
            "- Optionally call get_project_config to reuse the project's brand (title/voice) and products.\n" +
            "- Draft the full spec: a title and tagline, a theme (light/dark), 2–4 home-page sections (heading + a short paragraph each), and 1–3 initial sub-pages (e.g. pricing, about, contact) each with their own sections. Write real copy, not placeholders.\n" +
            "- Persist it in ONE call with scaffold_site (project, title, tagline, theme, sections, pages). Do not build it field-by-field.\n" +
            "- Then report the created home page + pages and note they were rendered to site/. Offer to tweak_site or add_page for follow-ups.",
        },
      },
    ],
  })
);

server.registerPrompt(
  "tweak_site",
  {
    title: "Tweak the website in natural language",
    description:
      "Apply a plain-English change to the project's website (e.g. 'make the tagline punchier', 'add a pricing section', 'switch to dark mode') and re-render.",
    argsSchema: {
      project: z.string().optional(),
      instruction: z.string().optional().describe("What to change on the site."),
    },
  },
  ({ project, instruction } = {}) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Tweak the website${project ? ` for project "${project}"` : ""}.\n\n` +
            (instruction ? `Change: ${instruction}\n\n` : "1. Ask me what to change if it isn't clear.\n") +
            "Steps:\n" +
            "- Call get_site (and list_pages if the change targets a sub-page) to see the current site.\n" +
            "- Apply the change with the smallest fitting tool: set_site (title/tagline/theme/sections), edit_site_section (one section), or add_page/remove_page (a page). Preserve everything you're not changing.\n" +
            "- Confirm what changed and note that the page(s) were re-rendered.",
        },
      },
    ],
  })
);

server.registerPrompt(
  "daily_plan",
  {
    title: "Plan today's work and dispatch it across models",
    description:
      "Build the day plan (model + effort per ticket), apply it, then start sub-agents on every planned ticket at the right model/effort tier.",
    argsSchema: {
      project: z.string().optional().describe("Board to plan. If omitted, ask or infer."),
      budget: z.string().optional().describe("Today's logged-token budget, e.g. 5000000."),
    },
  },
  ({ project, budget } = {}) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Run the daily plan${project ? ` for project "${project}"` : ""}.\n\n` +
            "1. Call daily_plan" + (budget ? ` with budgetTokens ${budget}` : "") + " (apply: false) and show me the plan: ticket, model, effort, estimate, and the dispatch groups. Pause for my go-ahead if anything looks off; otherwise continue.\n" +
            "2. Call daily_plan again with apply: true to stamp model:/effort: labels onto the tickets.\n" +
            "3. Dispatch: for every ticket in dispatch.parallel (sonnet/haiku), set_status In Progress, get_work_packet, and start a sub-agent at that model with the packet as its brief — these can run in parallel. When parallel tickets touch DISJOINT code areas, give each its own isolated git worktree (create_worktree) so agents don't edit the shared repo at once, then merge branches back SERIALLY and cleanup_worktree. Work dispatch.sequential tickets (opus/fable) one at a time: sub-agent or inline, with a review between tickets.\n" +
            "4. Effort mapping for each sub-agent brief: low \u2192 minimal exploration, make the obvious change, verify, stop; medium \u2192 normal loop with tests; high \u2192 read adjacent code first, consider invariants and back-compat, add tests, self-review the diff before finishing.\n" +
            "5. Only you (the orchestrator) write to the board. As each sub-agent finishes: verify its work, set_status Done with a completionSummary, log_work with tokens/additions/deletions and the model used, and commit per ticket (commit_feature) when git is configured.\n" +
            "6. Respect cap:<tokens> labels — wrap up and requeue any ticket about to exceed its cap.\n" +
            "7. When the plan is exhausted or the budget is spent, post a day summary to the scratchpad and report to me.",
        },
      },
    ],
  })
);

server.registerPrompt(
  "plan_goal",
  {
    title: "Turn one goal into a chained, parallelizable plan",
    description:
      "Decompose a single goal into 3\u201312 dependency-aware tickets, create them with plan_work in one call, then read back the execution waves — what can run in parallel and what must wait — and offer to start the first wave.",
    argsSchema: {
      project: z.string().optional().describe("Board to plan onto. If omitted, ask or infer."),
      goal: z.string().optional().describe("The goal to decompose. If omitted, ask me for it."),
    },
  },
  ({ project, goal } = {}) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Plan a goal into a chained set of tickets${project ? ` on project "${project}"` : ""}.\n\n` +
            (goal ? `Goal: ${goal}\n\n` : "1. Ask me for the goal if it isn\u2019t clear yet.\n\n") +
            "Steps:\n" +
            "1. Restate the goal in one line, then decompose it into 3\u201312 concrete tickets (features for new work, bugs for defects). Give each a short title, a description with the real detail, a product, and a priority. Identify which steps depend on which — a step that needs another\u2019s output must wait for it.\n" +
            "2. Call plan_work ONCE with the full features/bugs list. Set each item\u2019s dependsOn to the indices of its prerequisites in the COMBINED created list (features first, then bugs, in the order you list them). Add a cap:<tokens> label per item sized to its expected scope (e.g. cap:60k for a normal ticket, cap:200k for a big one) so the day plan can budget it.\n" +
            "3. Read the returned executionPlan and report the waves: wave 1 is everything that can start now in PARALLEL, each later wave lists what unblocks once the previous wave is done. Call out the edges (X blocked by Y) and surface any warnings (an out-of-range or cycle-closing dependency is skipped, not fatal — fix and note it).\n" +
            "4. Offer to start wave 1 now via the daily-plan dispatch flow: run daily_plan to stamp model:/effort: labels, then dispatch a sub-agent per ticket at its model/effort tier (sonnet/haiku in parallel, opus/fable sequentially). Only advance to the next wave once its blockers are Done. Wait for my go-ahead before dispatching.\n",
        },
      },
    ],
  })
);

server.registerPrompt(
  "refine",
  {
    title: "Refine a ticket's requirements",
    description:
      "Turn a thin ticket into a crisp requirements pad — intent, assumptions, acceptance criteria, open questions — and persist it with set_requirements.",
    argsSchema: {
      project: z.string().optional().describe("Board the ticket lives on. If omitted, ask or infer."),
      ticket: z.string().optional().describe("Ticket id to refine, e.g. FBF-12."),
    },
  },
  ({ project, ticket } = {}) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Refine the requirements for ${ticket ? `ticket "${ticket}"` : "a ticket"}${project ? ` on project "${project}"` : ""}, 8090-Refinery style:\n` +
            "1. Call get_work_packet for the ticket and read its scope, linked issue, and the files it points to at the code location — don't dump whole files.\n" +
            "2. Call get_requirements to see any existing pad, so you refine rather than clobber.\n" +
            "3. DRAFT the requirements: Intent (one or two sentences), Assumptions (what you're taking as given), Acceptance criteria (concrete, testable done-conditions), Open questions (genuinely ambiguous or risky items).\n" +
            "4. If there are real open questions or the scope is ambiguous, present the draft to me and ask before persisting. If it's unambiguous, proceed.\n" +
            "5. Persist with set_requirements. From then on the ticket's work packet carries these requirements and its definition-of-done becomes the acceptance criteria — keep them tight.\n" +
            "6. Report the pad path and a one-line summary of what you captured.",
        },
      },
    ],
  })
);

server.registerPrompt(
  "run_tests",
  {
    title: "Run the project's tests and record results",
    description:
      "Run the project's test suite(s), record each result with log_test_run, then show the consolidated per-suite view.",
    argsSchema: {
      project: z.string().optional(),
      suite: z.string().optional().describe("Limit to one suite/command, or omit to run them all."),
    },
  },
  ({ project, suite } = {}) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Run the tests${project ? ` for project "${project}"` : ""}${suite ? ` (suite: ${suite})` : ""} and record the results.\n\n` +
            "Steps:\n" +
            "- Find the test command from the project's codeLocation (get_project_config) — e.g. `npm test` / `node --test` — and run it in a shell.\n" +
            "- Parse the output for passed / failed / skipped counts" +
            (suite ? " for that suite." : ", per suite if the runner separates them.") +
            "\n- Record each with log_test_run (project, passed, failed, skipped, suite, and the related ticket if any).\n" +
            "- Then call test_runs_by_suite and summarize the latest status per suite, calling out any failing suites.",
        },
      },
    ],
  })
);

server.registerPrompt(
  "brand",
  {
    title: "Set up and apply consistent branding",
    description: "Establish the project's brand kit once, then apply it consistently across media, website, and campaigns.",
    argsSchema: { project: z.string().optional() },
  },
  ({ project } = {}) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Make branding consistent${project ? ` for project "${project}"` : ""}.\n\n` +
            "1. Call get_branding to see the current kit and which fields are missing.\n" +
            "2. Fill the gaps with set_branding — name, tagline, 3\u20136 brand words, a voice/tone line, primary + accent colors (hex), a font, and a logo ref if there is one. Ask me only for what you can't infer.\n" +
            "3. Apply it everywhere going forward: pass get_branding's `instruction` into every media generation; the website already picks up the brand colors/font (set_branding applyToSite, or set_site colors/font); keep campaigns, emails, and contracts on-voice.\n" +
            "4. Confirm the kit back to me in one short summary (name, colors, voice).",
        },
      },
    ],
  })
);

}
