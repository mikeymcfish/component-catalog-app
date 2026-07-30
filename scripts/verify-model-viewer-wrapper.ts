import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const wrapperPath = path.join(
  process.cwd(),
  "client",
  "src",
  "components",
  "model-3d-viewer.tsx",
);
const sourceText = fs.readFileSync(wrapperPath, "utf8");
const sourceFile = ts.createSourceFile(
  wrapperPath,
  sourceText,
  ts.ScriptTarget.ES2022,
  true,
  ts.ScriptKind.TSX,
);

let updateFramingCalls = 0;
let imperativeOrientationAssignments = 0;
let declarativeOrientation = false;
let orientationBoundKey = false;

function visit(node: ts.Node) {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "updateFraming"
  ) {
    updateFramingCalls += 1;
  }

  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(node.left) &&
    node.left.name.text === "orientation"
  ) {
    imperativeOrientationAssignments += 1;
  }

  if (
    ts.isJsxSelfClosingElement(node) &&
    node.tagName.getText(sourceFile) === "model-viewer"
  ) {
    for (const property of node.attributes.properties) {
      if (!ts.isJsxAttribute(property)) continue;
      const name = property.name.getText(sourceFile);
      const value = property.initializer?.getText(sourceFile) ?? "";
      if (name === "orientation" && value.includes("orientation")) {
        declarativeOrientation = true;
      }
      if (name === "key" && value.includes("orientation")) {
        orientationBoundKey = true;
      }
    }
  }

  ts.forEachChild(node, visit);
}

visit(sourceFile);

assert.equal(
  updateFramingCalls,
  0,
  "The model-viewer wrapper must not call updateFraming across its async lifecycle",
);
assert.equal(
  imperativeOrientationAssignments,
  0,
  "Loaded model-viewer elements must not receive imperative orientation updates",
);
assert(declarativeOrientation, "The model-viewer orientation must be supplied declaratively");
assert(
  orientationBoundKey,
  "Orientation changes must mount a fresh model-viewer so framing occurs during load",
);

console.log("Model viewer lifecycle verification passed.");
