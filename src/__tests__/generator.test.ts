import { describe, expect, it } from "vitest";

import {
  parseGrammarFromString_withClassic,
  parseGrammarFromString_withOhm,
} from "../generator";

describe("same impl", () => {
  it("simple example", () => {
    const newSyntax = `
      Abc { name: string }
    `;

    const oldSyntax = `Abc:
  name  \`string\`
`;

    expect(parseGrammarFromString_withOhm(newSyntax)).toEqual(
      parseGrammarFromString_withClassic(oldSyntax),
    );
  });

  it("same impl", () => {
    const newSyntax = `# This is a comment
   Abc {
     x0:
     string
     x1: string+
     x2: string*
     x3?:string y0:@Xyz
     y1: @Xyz*
     y2: @Xyz+
     y3?: @Xyz
     y4?: @Xyz
     z0: Pqr
     z1: Pqr+
     z2: Pqr*
     z3?: Pqr
   }
  
   @Xyz = Pqr | Stu
  
   Pqr {
     p?: number
   }
  
   # This is a comment
   Stu {
     s: number
   }
   `;

    const oldSyntax = `# This is a comment
   Abc:
     x0 \`string\`
     x1 \`string\`+
     x2 \`string\`*
     x3 \`string\`?
     y0 @Xyz
     y1 @Xyz*
     y2 @Xyz+
     y3 @Xyz?
     y4 @Xyz?
     z0 Pqr
     z1 Pqr+
     z2 Pqr*
     z3 Pqr?
  
   @Xyz:
     | Pqr
     | Stu
  
   Pqr:
     p \`number\`?
  
   # This is a comment
   Stu:
     s \`number\`
   `;

    expect(parseGrammarFromString_withOhm(newSyntax)).toEqual(
      parseGrammarFromString_withClassic(oldSyntax),
    );
  });
});

describe("parsing grammars", () => {
  it("parses a grammar", () => {
    expect(
      parseGrammarFromString_withClassic(`# This is a comment
   Abc:
     x0 \`string\`
     x1 \`string\`+
     x2 \`string\`*
     x3 \`string\`?
     y0 @Xyz
     y1 @Xyz*
     y2 @Xyz+
     y3 @Xyz?
     y4 @Xyz?
     z0 Pqr
     z1 Pqr+
     z2 Pqr*
     z3 Pqr?
  
   @Xyz:
     | Pqr
     | Stu
  
   Pqr:
     p \`number\`?
  
   # This is a comment
   Stu:
     s \`number\`
   `),
    ).toMatchSnapshot();
  });
});
