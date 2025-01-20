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

describe("checking document validity", () => {
  it("thrown where there is a duplicate def (node)", () => {
    expect(() =>
      parseGrammarFromString_withOhm(`
      Foo {}
      Foo {}
   `),
    ).toThrow("Duplicate definition of 'Foo'");
  });

  it("thrown where there is a duplicate union def (node)", () => {
    expect(() =>
      parseGrammarFromString_withOhm(`
      Foo {}
      Bar {}
      @Bar = Foo
      @Bar = Bar
   `),
    ).toThrow("Duplicate definition of 'Bar'");
  });

  it("thrown where there is a duplicate def (node + union)", () => {
    expect(() =>
      parseGrammarFromString_withOhm(`
      Foo {}
      Bar {}
      @Foo = Bar
   `),
    ).toThrow("Duplicate definition of 'Foo'");
  });

  it("thrown when there is an unknown reference (node)", () => {
    expect(() =>
      parseGrammarFromString_withOhm(`
      Foo { bar: Ba }
      #          ^^ Typo, should fail
      Bar { }
   `),
    ).toThrow("Cannot find 'Ba'");
  });

  it("thrown when there is an unknown reference (node)", () => {
    expect(() =>
      parseGrammarFromString_withOhm(`
      Foo { bar: @Ba }
      #          ^^^ Typo, should fail
      @Bar = Qux | Mutt
      Qux {}
      Mutt {}
   `),
    ).toThrow("Cannot find '@Ba'");
  });

  it("thrown when there is an unused node def", () => {
    expect(() =>
      parseGrammarFromString_withOhm(`
      Foo { }
      Bar { }
   `),
    ).toThrow("Unused definition 'Bar'");
  });

  it("thrown when there is an unused union def", () => {
    expect(() =>
      parseGrammarFromString_withOhm(`
      Foo { }
      @Bar = Foo
   `),
    ).toThrow("Unused definition '@Bar'");
  });

  it.skip("[todo later] thrown when there is a circular ref", () => {
    expect(() =>
      parseGrammarFromString_withOhm(`
      Foo { foo: Foo }
   `),
    ).toThrow("Circular ref 'Foo'");
  });
});
