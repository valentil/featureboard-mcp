// Auto-extracted from server/index.js (FBMCPF-224). Registration blocks moved verbatim.
export function registerMediaTools(server, ctx) {
  const { Board, addComment, annotateMedia, draftShare, editMediaText, getBoard, getMedia, listComments, listMedia, listShares, listUploads, listVariations, meta, removeAnnotation, removeComment, removeShare, revertMedia, saveMedia, saveUpload, searchMedia, tagMedia, tryTool, writeTool, z } = ctx;

server.registerTool(
  "list_media",
  {
    title: "List media assets",
    description:
      "List a project's media gallery: images and shareable HTML reports in its media/ folder. Each asset carries enough to render a visual grid — kind, mimeType, sizeBytes + sizeLabel + sizeBucket, image dimensions (width/height, parsed from file headers), a preview reference (inline text snippet for reports, a get_media src for images), plus sidecar metadata (title, tags, brandWords, linked ticket). Read-only; returns an empty gallery if the project has no media/ folder yet. Optionally filter by kind.",
    inputSchema: {
      project: z.string(),
      kind: z.enum(["image", "report", "other"]).optional().describe("Filter to one media kind."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, kind }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listMedia(board, project, { kind });
  })
);

server.registerTool(
  "save_media",
  {
    title: "Save media asset",
    description:
      "Save a generated asset into a project's media/ folder — a shareable HTML report (or SVG) as UTF-8 text, or an image as base64 (encoding:'base64'). You generate the content; this persists the bytes plus a <name>.meta.json sidecar (title, prompt, tags, linked ticket, generatedAt) that list_media reads back. Name must be a plain filename with an extension, e.g. q3-report.html.",
    inputSchema: {
      project: z.string(),
      name: z.string().describe("Plain filename with extension, e.g. launch-report.html or chart.png."),
      content: z.string().describe("Asset contents: UTF-8 text, or base64 when encoding is 'base64'."),
      encoding: z.enum(["utf8", "base64"]).optional().default("utf8"),
      title: z.string().optional().describe("Human title for the gallery."),
      prompt: z.string().optional().describe("The prompt/goal this asset was generated from."),
      tags: z.array(z.string()).optional(),
      ticket: z.string().optional().describe("Board ticket this asset relates to, e.g. FBMCPF-39."),
      group: z.string().optional().describe("Variation group id — save siblings under one group for side-by-side review (list_variations)."),
      brandWords: z.array(z.string()).optional().describe("Brand/trial words woven into this asset. If omitted, the project's configured brandWords are recorded automatically."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, content, encoding, title, prompt, tags, ticket, group, brandWords }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    // Default the recorded brand words to the project's configured set so generated assets carry their branding.
    const bw = brandWords && brandWords.length ? brandWords : meta.brandContext(board, project).words;
    return saveMedia(board, project, { name, content, encoding, title, prompt, tags, ticket, group, brandWords: bw });
  })
);

server.registerTool(
  "list_variations",
  {
    title: "List a variation group",
    description: "List the gallery assets that share a variation group id (alternatives generated from one prompt), for side-by-side review.",
    inputSchema: { project: z.string(), group: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, group }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listVariations(board, project, group);
  })
);

server.registerTool(
  "get_media",
  {
    title: "View a media asset",
    description:
      "View one media asset: its metadata, size, and (by default) content — UTF-8 for text/report assets, base64 for images — plus its revision history (prior versions with the prompts used). Pass a version id to view an archived revision instead of the current one; set withContent:false for metadata + history only.",
    inputSchema: {
      project: z.string(),
      name: z.string().describe("Asset filename, e.g. q3-report.html."),
      version: z.string().optional().describe("Archived version id (from the versions list) to view instead of current."),
      withContent: z.boolean().optional().default(true),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, name, version, withContent }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return getMedia(board, project, name, { version, withContent });
  })
);

server.registerTool(
  "revert_media",
  {
    title: "Revert a media asset",
    description:
      "Restore a prior version of an asset as the current one. The current copy is archived first, so the revert is itself undoable. Use get_media to find the version id.",
    inputSchema: {
      project: z.string(),
      name: z.string(),
      version: z.string().describe("Version id to restore (from get_media's versions list)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, version }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return revertMedia(board, project, name, version);
  })
);

server.registerTool(
  "tag_media",
  {
    title: "Tag a media asset",
    description:
      "Add and/or remove custom tags on a media asset (updates the sidecar only — the asset bytes and version history are untouched). Tags are de-duplicated. Returns the asset's new tag list.",
    inputSchema: {
      project: z.string(),
      name: z.string(),
      add: z.array(z.string()).optional(),
      remove: z.array(z.string()).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, add, remove }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return tagMedia(board, project, name, { add, remove });
  })
);

server.registerTool(
  "annotate_media",
  {
    title: "Annotate a media asset",
    description:
      "Add a pin-based comment/annotation to an asset. Optional x/y locate the pin (e.g. 0-1 relative coordinates on an image or report). Returns the new annotation (with a stable id) and the total count.",
    inputSchema: {
      project: z.string(),
      name: z.string(),
      text: z.string().describe("Annotation/comment body."),
      x: z.number().optional().describe("Pin x (e.g. 0-1 relative)."),
      y: z.number().optional().describe("Pin y (e.g. 0-1 relative)."),
      author: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, text, x, y, author }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return annotateMedia(board, project, name, { text, x, y, author });
  })
);

server.registerTool(
  "remove_annotation",
  {
    title: "Remove a media annotation",
    description: "Remove an annotation from an asset by its id (from get_media). Returns the remaining count.",
    inputSchema: { project: z.string(), name: z.string(), id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, id }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return removeAnnotation(board, project, name, id);
  })
);

server.registerTool(
  "add_media_comment",
  {
    title: "Comment on a media asset",
    description:
      "Add a threaded comment to a gallery asset (a discussion thread, distinct from pin annotations). Pass parentId (a comment id from get_media / list_media_comments) to reply to an existing comment. Returns the new comment and total count.",
    inputSchema: {
      project: z.string(),
      name: z.string().describe("Asset filename, e.g. launch-report.html."),
      body: z.string().describe("Comment text."),
      author: z.string().optional().describe("Who is commenting."),
      parentId: z.string().optional().describe("Comment id to reply to (omit for a top-level comment)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, body, author, parentId }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return addComment(board, project, name, { body, author, parentId });
  })
);

server.registerTool(
  "list_media_comments",
  {
    title: "List media comments",
    description: "List an asset's comments, both as a flat array and as a threaded tree (root comments with nested replies).",
    inputSchema: { project: z.string(), name: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, name }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listComments(board, project, name);
  })
);

server.registerTool(
  "remove_media_comment",
  {
    title: "Remove a media comment",
    description:
      "Remove a comment by id (from get_media / list_media_comments). By default its reply subtree is removed too; set cascade:false to refuse when it still has replies. Returns the ids removed.",
    inputSchema: {
      project: z.string(),
      name: z.string(),
      id: z.string(),
      cascade: z.boolean().optional().default(true).describe("Remove the comment's replies too (default true)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, id, cascade }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return removeComment(board, project, name, id, { cascade });
  })
);

server.registerTool(
  "search_media",
  {
    title: "Search media assets",
    description:
      "Search/filter a project's media gallery by kind, by exact tag, and/or a free-text query matched across asset name, title, tags, and the generation prompt. Returns matching assets with metadata.",
    inputSchema: {
      project: z.string(),
      query: z.string().optional(),
      tag: z.string().optional(),
      kind: z.enum(["image", "report", "other"]).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, query, tag, kind }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return searchMedia(board, project, { query, tag, kind });
  })
);

server.registerTool(
  "upload_reference",
  {
    title: "Upload a reference image",
    description:
      "Save a reference/source image under media/uploads/ (base64) to use as input for media generation — kept separate from the gallery. Reference it in a generate/refine prompt so Claude or an image model can work from it.",
    inputSchema: {
      project: z.string(),
      name: z.string().describe("Filename with extension, e.g. moodboard.png."),
      content: z.string().describe("Base64 image bytes (or utf8 text with encoding:'utf8')."),
      encoding: z.enum(["base64", "utf8"]).optional().default("base64"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, content, encoding }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return saveUpload(board, project, { name, content, encoding });
  })
);

server.registerTool(
  "list_references",
  {
    title: "List reference uploads",
    description: "List the reference/source images under media/uploads/ (inputs for generation).",
    inputSchema: { project: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listUploads(board, project);
  })
);

server.registerTool(
  "edit_media",
  {
    title: "Edit a text media asset",
    description:
      "Directly edit an existing text/report asset (find/replace, append, or prepend) and save the result as a new version — the prior copy is archived (edit-media). For images, use refine_media or image generation instead.",
    inputSchema: {
      project: z.string(),
      name: z.string().describe("Gallery asset (a text/report asset: .html/.svg/.txt/.md…)."),
      find: z.string().optional().describe("Text to replace (all occurrences)."),
      replace: z.string().optional().describe("Replacement for 'find' (default: remove)."),
      append: z.string().optional(),
      prepend: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, name, find, replace, append, prepend }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return editMediaText(board, project, name, { find, replace, append, prepend });
  })
);

server.registerTool(
  "draft_share",
  {
    title: "Draft a social share",
    description:
      "Save a reviewable social-share draft for a gallery item — you write the copy, this persists it (never posts). Platform 'x' (≤280 chars) or 'linkedin' (longer); over-limit copy is rejected. There is no live-publish connector: drafts are for the user to review and post. Use list_shares to review.",
    inputSchema: {
      project: z.string(),
      platform: z.enum(["x", "linkedin"]),
      text: z.string().describe("The suggested post copy (short for X, longer for LinkedIn)."),
      asset: z.string().optional().describe("Gallery asset this share is for, e.g. q3-report.html."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, platform, text, asset }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return draftShare(board, project, { platform, text, asset });
  })
);

server.registerTool(
  "list_shares",
  {
    title: "List social share drafts",
    description: "List saved share drafts (newest-first), optionally filtered by asset and/or platform.",
    inputSchema: {
      project: z.string(),
      asset: z.string().optional(),
      platform: z.enum(["x", "linkedin"]).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  tryTool(({ project, asset, platform }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return listShares(board, project, { asset, platform });
  })
);

server.registerTool(
  "remove_share",
  {
    title: "Remove a social share draft",
    description: "Delete a share draft by its id (from list_shares).",
    inputSchema: { project: z.string(), id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  writeTool(({ project, id }) => {
    const board = getBoard();
    if (!board.projectExists(project)) throw new Error(`Project "${project}" not found.`);
    return removeShare(board, project, id);
  })
);

}
