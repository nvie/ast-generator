import { describe, it, expect } from "vitest";
import { parseGrammarFromString } from "../generator";

describe("parsing grammars", () => {
  it("parses a grammar", () => {
    expect(
      parseGrammarFromString(`# This is a comment
Abc:
  x0: \`string\`
  x1: \`string\`+
  x2: \`string\`*
  x3: \`string\`?
  y0: @Xyz
  y1: @Xyz*
  y2: @Xyz+
  y3: @Xyz?
  y4: @Xyz?
  z0: Pqr
  z1: Pqr+
  z2: Pqr*
  z3: Pqr?

@Xyz:
  | Pqr
  | Stu

Pqr:
  p: \`number\`?

# This is a comment
Stu:
  s: \`number\`
`)
    ).toMatchSnapshot();
  });
});
