import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  normalizeDueDate,
  DUE_DATE_RE,
  parseMarkdown,
  Board,
} from "../server/storage.js";

// Helper to create a temporary project directory
function createTempProject() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fbmcpb10-"));
  fs.mkdirSync(path.join(tmpDir, ".featureboard"), { recursive: true });
  
  // Initialize counter file
  const indexPath = path.join(tmpDir, ".featureboard", "index.json");
  fs.writeFileSync(indexPath, JSON.stringify({}));
  
  // Create feature and bug files
  fs.writeFileSync(path.join(tmpDir, "featurelist.md"), "# Feature List\n");
  fs.writeFileSync(path.join(tmpDir, "buglist.md"), "# Bug List\n");
  
  return tmpDir;
}

function cleanupTempProject(tmpDir) {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true });
  }
}

// Test normalizeDueDate with valid date format
test("normalizeDueDate handles null input", () => {
  const result = normalizeDueDate(null);
  assert.deepEqual(result, { dueDate: null });
});

test("normalizeDueDate handles whitespace string as overflow", () => {
  const result = normalizeDueDate("   ");
  // Whitespace trims to empty string which is treated as overflow
  assert.deepEqual(result, { dueDate: null, overflow: "" });
});

test("normalizeDueDate rejects prose description as junk", () => {
  const result = normalizeDueDate("Legacy tickets carry prose descriptions in their due field");
  assert.deepEqual(result, {
    dueDate: null,
    overflow: "Legacy tickets carry prose descriptions in their due field",
  });
});

test("normalizeDueDate rejects US date format", () => {
  const result = normalizeDueDate("07/16/2026");
  assert.deepEqual(result, { dueDate: null, overflow: "07/16/2026" });
});

test("normalizeDueDate rejects DD-MM-YYYY format", () => {
  const result = normalizeDueDate("16-07-2026");
  assert.deepEqual(result, { dueDate: null, overflow: "16-07-2026" });
});

test("normalizeDueDate rejects partial date", () => {
  const result = normalizeDueDate("2026-07");
  assert.deepEqual(result, { dueDate: null, overflow: "2026-07" });
});

test("DUE_DATE_RE matches valid YYYY-MM-DD", () => {
  assert.match("2026-07-16", DUE_DATE_RE);
  assert.match("2000-01-01", DUE_DATE_RE);
  assert.match("2099-12-31", DUE_DATE_RE);
});

test("DUE_DATE_RE rejects non-matching formats", () => {
  assert.doesNotMatch("07/16/2026", DUE_DATE_RE);
  assert.doesNotMatch("2026-7-16", DUE_DATE_RE);
  assert.doesNotMatch("2026-07-6", DUE_DATE_RE);
  assert.doesNotMatch("16-07-2026", DUE_DATE_RE);
  assert.doesNotMatch("prose text", DUE_DATE_RE);
});

test("addTask stores valid dueDate without modification", () => {
  const tmpDir = createTempProject();
  try {
    const board = new Board(tmpDir);
    const project = "test-project";
    board.createProject(project);

    const result = board.addTask(project, "feature", {
      title: "Test Feature",
      description: "Test description",
      dueDate: "2026-07-20",
    });

    assert.equal(result.dueDate, "2026-07-20");
    assert.equal(result.description, "Test description");
  } finally {
    cleanupTempProject(tmpDir);
  }
});

test("addTask moves junk dueDate to description", () => {
  const tmpDir = createTempProject();
  try {
    const board = new Board(tmpDir);
    const project = "test-project";
    board.createProject(project);

    const result = board.addTask(project, "feature", {
      title: "Test Feature",
      description: "Original description",
      dueDate: "Legacy tickets carry prose descriptions in their due field",
    });

    assert.equal(result.dueDate, null);
    assert.match(
      result.description,
      /Original description.*Legacy tickets carry prose descriptions in their due field/
    );
  } finally {
    cleanupTempProject(tmpDir);
  }
});

test("addTask with junk dueDate and empty description creates description from junk", () => {
  const tmpDir = createTempProject();
  try {
    const board = new Board(tmpDir);
    const project = "test-project";
    board.createProject(project);

    const result = board.addTask(project, "feature", {
      title: "Test Feature",
      dueDate: "some prose that should not be a date",
    });

    assert.equal(result.dueDate, null);
    assert.equal(result.description, "some prose that should not be a date");
  } finally {
    cleanupTempProject(tmpDir);
  }
});

test("updateTask accepts valid dueDate", () => {
  const tmpDir = createTempProject();
  try {
    const board = new Board(tmpDir);
    const project = "test-project";
    board.createProject(project);

    const task = board.addTask(project, "feature", {
      title: "Test Feature",
      description: "Original",
      dueDate: "2026-07-16",
    });

    const updated = board.updateTask(project, task.ticketNumber, {
      dueDate: "2026-08-20",
    });

    assert.equal(updated.dueDate, "2026-08-20");
  } finally {
    cleanupTempProject(tmpDir);
  }
});

test("parseMarkdown preserves junk dueDate as-is from markdown", () => {
  const markdown = `# Feature List
- [ ] [FBF-1] **Test**: desc [Created: 2026-07-16 | Due: Legacy prose description here]`;

  const tasks = parseMarkdown(markdown, "test.md");

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].dueDate, "Legacy prose description here");
});

test("parseMarkdown extracts valid YYYY-MM-DD from due field", () => {
  const markdown = `# Feature List
- [ ] [FBF-1] **Test**: desc [Created: 2026-07-16 | Due: 2026-07-20]`;

  const tasks = parseMarkdown(markdown, "test.md");

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].dueDate, "2026-07-20");
});

test("addTask appends junk dueDate to existing description", () => {
  const tmpDir = createTempProject();
  try {
    const board = new Board(tmpDir);
    const project = "test-project";
    board.createProject(project);

    const result = board.addTask(project, "feature", {
      title: "Test Feature",
      description: "Original description",
      dueDate: "ASAP or whenever",
    });

    assert.equal(result.dueDate, null);
    assert.match(result.description, /Original description/);
    assert.match(result.description, /ASAP or whenever/);
  } finally {
    cleanupTempProject(tmpDir);
  }
});

test("valid dueDate values can be sorted chronologically", () => {
  const tmpDir = createTempProject();
  try {
    const board = new Board(tmpDir);
    const project = "test-project";
    board.createProject(project);

    const task1 = board.addTask(project, "feature", {
      title: "First",
      dueDate: "2026-07-16",
    });
    const task2 = board.addTask(project, "feature", {
      title: "Second",
      dueDate: "2026-07-20",
    });
    const task3 = board.addTask(project, "feature", {
      title: "Third",
      dueDate: "2026-07-10",
    });

    const dates = [task1.dueDate, task2.dueDate, task3.dueDate];
    const sorted = [...dates].sort();

    assert.deepEqual(sorted, ["2026-07-10", "2026-07-16", "2026-07-20"]);
  } finally {
    cleanupTempProject(tmpDir);
  }
});

test("junk dueDate does not remain in task.dueDate after normalization", () => {
  const tmpDir = createTempProject();
  try {
    const board = new Board(tmpDir);
    const project = "test-project";
    board.createProject(project);

    const result = board.addTask(project, "feature", {
      title: "Test",
      dueDate: "ASAP",
    });

    assert.equal(result.dueDate, null);
    // Verify dueDate is null or a valid YYYY-MM-DD string
    assert.ok(result.dueDate === null || typeof result.dueDate === "string");
  } finally {
    cleanupTempProject(tmpDir);
  }
});

test("addTask with multiple fields including junk dueDate preserves other fields", () => {
  const tmpDir = createTempProject();
  try {
    const board = new Board(tmpDir);
    const project = "test-project";
    board.createProject(project);

    const result = board.addTask(project, "feature", {
      title: "Test Feature",
      description: "Important work",
      dueDate: "before the next sprint",
      product: "Core",
      labels: ["urgent", "backend"],
      priority: 1,
    });

    assert.equal(result.dueDate, null);
    assert.equal(result.product, "Core");
    assert.deepEqual(result.labels, ["urgent", "backend"]);
    assert.equal(result.priority, 1);
    assert.match(result.description, /Important work/);
    assert.match(result.description, /before the next sprint/);
  } finally {
    cleanupTempProject(tmpDir);
  }
});

test("normalizeDueDate rejects dates without dashes", () => {
  const result = normalizeDueDate("20260716");
  assert.deepEqual(result, { dueDate: null, overflow: "20260716" });
});

test("addTask with bug type moves junk dueDate to description", () => {
  const tmpDir = createTempProject();
  try {
    const board = new Board(tmpDir);
    const project = "test-project";
    board.createProject(project);

    const result = board.addTask(project, "bug", {
      title: "Critical Bug",
      dueDate: "Fix ASAP - legacy description",
    });

    assert.equal(result.dueDate, null);
    assert.equal(result.description, "Fix ASAP - legacy description");
  } finally {
    cleanupTempProject(tmpDir);
  }
});

test("board with mixed valid/invalid dueDate values handles both correctly", () => {
  const tmpDir = createTempProject();
  try {
    const board = new Board(tmpDir);
    const project = "test-project";
    board.createProject(project);

    const validTask = board.addTask(project, "feature", {
      title: "Valid",
      dueDate: "2026-07-25",
    });

    const invalidTask = board.addTask(project, "feature", {
      title: "Invalid",
      dueDate: "before sprint ends",
    });

    assert.equal(validTask.dueDate, "2026-07-25");
    assert.equal(invalidTask.dueDate, null);
    assert.equal(invalidTask.description, "before sprint ends");
  } finally {
    cleanupTempProject(tmpDir);
  }
});
