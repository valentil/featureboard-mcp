#!/usr/bin/env node
/**
 * mcp-smoke.mjs — end-to-end smoke test of the FeatureBoard MCP server.
 *
 * Spawns server/index.js over stdio (exactly how Claude Desktop talks to it),
 * lists the tools, and exercises the ones the board UI + the ported modules use —
 * including the newer ones (scratchpad, media, CRM, leads, mail, campaigns,
 * website, git). Runs against a throwaway boards folder, so it never touches real
 * data. Exits non-zero if anything is missing or errors.
 *
 * Run:  npm run smoke     (no Claude Desktop needed)
 *
 * This is the fast inner loop: edit server → npm run smoke → green → only then
 * rebuild the .mcpb. It confirms the interface before you ever reinstall.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-smoke-"));
const P = "SmokeProject";

const results = [];
let failed = 0;
const txt = (r) => (r && r.content && r.content[0] && r.content[0].text) || "";
const data = (r) => (r.structuredContent != null ? r.structuredContent : JSON.parse(txt(r)));

async function step(name, fn) {
  try {
    const v = await fn();
    results.push(["PASS", name]);
    return v;
  } catch (e) {
    results.push(["FAIL", `${name} — ${e.message}`]);
    failed += 1;
    return null;
  }
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join("server", "index.js")],
    cwd: root,
    env: { ...process.env, FEATUREBOARD_DATA_DIR: dataDir },
  });
  const client = new Client({ name: "fb-smoke", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  // 1. Tools are exposed
  const toolList = await client.listTools();
  const names = new Set(toolList.tools.map((t) => t.name));
  const expect = [
    "list_projects", "create_project", "add_feature", "set_status", "get_metrics",
    "get_scratchpad", "set_scratchpad",                       // the panel that was "missing"
    "list_media", "save_media", "get_media",                 // media
    "add_company", "add_contact", "link_customer_ticket", "customer_portal", // CRM
    "add_lead", "leads_map",                                  // leads
    "draft_email", "list_mail", "create_campaign",            // mail & marketing
    "get_site", "set_site", "enable_login_gate",              // website
    "get_git_config", "set_git_config", "commit_feature",     // git
    "list_contract_templates", "generate_contract",           // contracts
  ];
  await step(`tools/list exposes ${expect.length} expected tools (of ${names.size} total)`, async () => {
    const missing = expect.filter((n) => !names.has(n));
    if (missing.length) throw new Error("missing tools: " + missing.join(", "));
    return true;
  });

  const call = (name, args = {}) => client.callTool({ name, arguments: { project: P, ...args } });
  const ok = async (name, args, label) =>
    step(label || name, async () => {
      const r = await call(name, args);
      if (r.isError) throw new Error(txt(r));
      return data(r);
    });

  // 2. Core board flow
  await step("set_usage_type personal (allow writes)", async () => {
    const r = await client.callTool({ name: "set_usage_type", arguments: { type: "personal" } });
    if (r.isError) throw new Error(txt(r));
  });
  await step("create_project", async () => {
    const r = await client.callTool({ name: "create_project", arguments: { name: P, description: "smoke" } });
    if (r.isError) throw new Error(txt(r));
    return data(r);
  });
  const feat = await ok("add_feature", { title: "Smoke feature", product: "Core" });
  const ticket = feat && (feat.ticketNumber || feat.ticket);
  await ok("set_status", { ticket, status: "In Progress" }, "set_status In Progress");
  await ok("get_metrics", {});

  // 3. Scratchpad round-trip (the panel that reported "needs updated server")
  await ok("set_scratchpad", { content: "hello from smoke" });
  await step("get_scratchpad returns what we set", async () => {
    const r = await call("get_scratchpad", {});
    if (r.isError) throw new Error(txt(r));
    if (!txt(r).includes("hello from smoke") && !JSON.stringify(data(r)).includes("hello from smoke"))
      throw new Error("scratchpad content did not round-trip");
  });

  // 4. Ported modules
  await ok("save_media", { name: "smoke.html", content: "<h1>hi</h1>", title: "Smoke" });
  await ok("list_media", {});
  await ok("add_company", { name: "Acme Smoke" });
  await ok("add_contact", { company: "acme-smoke", name: "Ada" });
  await ok("link_customer_ticket", { company: "acme-smoke", ticket });
  await ok("customer_portal", { company: "acme-smoke" });
  await ok("add_lead", { name: "Lead A", city: "DC", lat: 38.9, lng: -77, value: 1000 });
  await ok("leads_map", {});
  await ok("draft_email", { to: "a@b.com", subject: "Hi", body: "yo" });
  await ok("create_campaign", { name: "Launch", recipients: ["a@b.com", "c@d.io"] });
  await ok("generate_contract", { template: "nda", company: "acme-smoke", vars: { provider: "FB LLC", effective_date: "2026-07-14" } });
  await ok("set_site", { title: "Smoke Site", sections: [{ heading: "About", body: "hi" }] });
  await ok("get_site", {});
  await ok("enable_login_gate", { passcode: "1234" });
  await ok("get_git_config", {});
  await ok("set_git_config", { enabled: true, branch: "main" });
  await step("commit_feature no-ops safely (no repo configured)", async () => {
    const r = await call("commit_feature", { ticket, title: "Smoke feature" });
    // Either a clean skip/failure message is fine — it must not throw/crash the server.
    if (r.isError && !/disabled|code repo|not a git repo|codeLocation/i.test(txt(r))) throw new Error(txt(r));
  });

  await client.close();

  // Report
  const pass = results.filter((r) => r[0] === "PASS").length;
  console.log("\nFeatureBoard MCP smoke test");
  console.log("─".repeat(48));
  for (const [status, name] of results) console.log(`  ${status === "PASS" ? "✓" : "✗"} ${name}`);
  console.log("─".repeat(48));
  console.log(`  ${pass}/${results.length} passed` + (failed ? `, ${failed} FAILED` : ""));
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Smoke test crashed:", e.stack || e.message);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
